import type { Pool } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import { inTransaction } from '@/platform/database/transaction';

// docs/design/pwa-push.md section 3, Lifecycle "Expiry": a binding lives until
// its entry (or session) is terminal plus the 15-minute terminal grace, and at
// most 24 hours (the row's expires_at). Then it is revoked as `expired` and its
// sealed subscription scrubbed. The sweep needs no seal secret: it never opens
// a subscription.
const TERMINAL_GRACE = '15 minutes';
const SWEEP_BATCH = 200;

/**
 * Revokes and scrubs every due binding. Rows locked by a concurrent
 * subscribe/transfer/unsubscribe are skipped (never waited on, so no lock-order
 * cycle with the transfer's endpoint-then-row order) and picked up next tick.
 * Push consent is revoked once the patient keeps no active binding. Returns the
 * number of bindings expired.
 */
export async function sweepExpiredPushBindings(
  pool: Pool,
  now: Date = new Date(),
): Promise<number> {
  return inTransaction(pool, async (client) => {
    const due = await client.query<{
      id: string;
      clinic_id: string;
      queue_entry_id: string;
      patient_id: string;
    }>(
      `SELECT sub.id, sub.clinic_id, sub.queue_entry_id, entry.patient_id
         FROM guest_push_subscriptions sub
         JOIN queue_entries entry
           ON entry.id=sub.queue_entry_id AND entry.clinic_id=sub.clinic_id
         JOIN consultation_sessions session
           ON session.id=entry.session_id AND session.clinic_id=entry.clinic_id
        WHERE sub.revoked_at IS NULL
          AND (sub.expires_at <= $1
            OR (entry.state IN ('completed','cancelled','no_show')
                AND COALESCE(entry.completed_at, entry.updated_at)
                    + interval '${TERMINAL_GRACE}' <= $1)
            OR (session.status IN ('closed','cancelled')
                AND COALESCE(session.closed_at, session.updated_at)
                    + interval '${TERMINAL_GRACE}' <= $1))
        ORDER BY sub.id
        LIMIT ${SWEEP_BATCH}
        FOR UPDATE OF sub SKIP LOCKED`,
      [now],
    );
    if (due.rowCount === 0) return 0;
    await client.query(
      `UPDATE guest_push_subscriptions
          SET revoked_at=GREATEST($2::timestamptz, created_at),
              revocation_reason='expired', sealed_subscription=NULL
        WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL`,
      [due.rows.map((row) => row.id), now],
    );
    // Keyed by patient id alone on purpose: patient_operational_records.id is the
    // table's PRIMARY KEY (db/migrations/0004_walkin_queue_foundation.sql) and each
    // record carries exactly one clinic_id, so a patient id maps to one clinic.
    const patients = new Map<string, string>();
    for (const row of due.rows) patients.set(row.patient_id, row.clinic_id);
    for (const [patientId, clinicId] of patients) {
      // Serialize with a concurrent subscribe: it inserts its binding and then
      // upserts this consent row, so taking the row lock first makes the
      // remaining-binding check below see (or wait for) its binding and never
      // revoke consent that a just-created binding depends on.
      const pref = await client.query(
        `SELECT 1 FROM notification_preferences
          WHERE clinic_id=$1 AND patient_id=$2 AND channel='push'
            AND consent_state='granted'
          FOR UPDATE`,
        [clinicId, patientId],
      );
      if (pref.rowCount === 0) continue;
      const remaining = await client.query(
        `SELECT 1 FROM guest_push_subscriptions sub
           JOIN queue_entries entry
             ON entry.id=sub.queue_entry_id AND entry.clinic_id=sub.clinic_id
          WHERE sub.clinic_id=$1 AND entry.patient_id=$2 AND sub.revoked_at IS NULL
          LIMIT 1`,
        [clinicId, patientId],
      );
      if (remaining.rowCount === 0)
        await client.query(
          `UPDATE notification_preferences
              SET consent_state='revoked', revision=revision+1, updated_at=now()
            WHERE clinic_id=$1 AND patient_id=$2 AND channel='push'
              AND consent_state='granted'`,
          [clinicId, patientId],
        );
    }
    for (const row of due.rows)
      await appendAuditEvent(client, {
        clinicId: row.clinic_id,
        actorUserId: null,
        entityType: 'queue_entry',
        entityId: row.queue_entry_id,
        action: 'guest_push_expired',
        metadata: { subscriptionId: row.id },
      });
    return due.rows.length;
  });
}
