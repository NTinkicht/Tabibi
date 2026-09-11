import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const migrationsThrough0018 = [
  '0001_platform_baseline.sql',
  '0002_clinic_scheduling_foundation.sql',
  '0003_session_operations.sql',
  '0004_walkin_queue_foundation.sql',
  '0005_queue_lifecycle.sql',
  '0006_queue_priority_order.sql',
  '0007_waiting_room_public_labels.sql',
  '0008_queue_eta_timing.sql',
  '0009_appointment_booking_foundation.sql',
  '0010_appointment_booking_constraint_validation.sql',
  '0011_appointment_lifecycle.sql',
  '0012_appointment_lifecycle_terminal_commands.sql',
  '0013_appointment_recovery.sql',
  '0014_guest_exchange_credential_foundation.sql',
  '0015_guest_status_rate_limit.sql',
  '0016_notification_outbox_foundation.sql',
  '0017_notification_dispatch_claim.sql',
  '0018_notification_dispatch_outcomes.sql',
];

async function migration(name: string): Promise<string> {
  return readFile(resolve(process.cwd(), 'db/migrations', name), 'utf8');
}

async function applyNonTransactional(client: Client, name: string) {
  const sql = await migration(name);
  const statements = sql
    .split(';')
    .map((statement) =>
      statement.replace('-- tabibi:no-transaction', '').trim(),
    )
    .filter(Boolean);
  for (const statement of statements) await client.query(statement);
}

describe('notification retry migration order', () => {
  it('backfills legacy retry deadlines and preserves retry ceilings before claims become eligible', async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    const schema = `retry_migration_${randomUUID().replaceAll('-', '')}`;
    const clinicId = randomUUID();
    const failedId = randomUUID();
    const unknownId = randomUUID();
    const failedLastAttempt = new Date('2026-01-01T00:00:00.000Z');
    const unknownLastAttempt = new Date('2026-01-01T01:00:00.000Z');

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      for (const name of migrationsThrough0018) {
        await client.query(await migration(name));
      }

      await client.query(
        `INSERT INTO clinics (id, tenant_key, name)
         VALUES ($1, $2, 'Legacy Retry Clinic')`,
        [clinicId, `legacy-retry-${clinicId}`],
      );
      await client.query(
        `INSERT INTO notification_outbox (
           id, clinic_id, logical_target_key, event_key, intent_version,
           idempotency_key, state, payload, dispatch_attempt_count,
           dispatch_last_attempt_at, dispatch_outcome_at, dispatch_outcome_code
         ) VALUES
           ($1,$3,'legacy:failed','turn_approaching',1,'legacy-failed','failed','{}'::jsonb,1,$4,$4,'provider_transient'),
           ($2,$3,'legacy:unknown','turn_approaching',1,'legacy-unknown','unknown','{}'::jsonb,3,$5,$5,'provider_unknown')`,
        [failedId, unknownId, clinicId, failedLastAttempt, unknownLastAttempt],
      );

      await client.query(await migration('0019_notification_retry_eligibility.sql'));
      await client.query(
        await migration('0020_notification_retry_constraint_validation.sql'),
      );
      await applyNonTransactional(client, '0021_notification_retry_claim_index.sql');

      const backfilled = await client.query<{
        id: string;
        state: string;
        dispatch_max_attempts: number;
        next_attempt_at: Date | null;
      }>(
        `SELECT id, state, dispatch_max_attempts, next_attempt_at
           FROM notification_outbox
          WHERE id IN ($1, $2)
          ORDER BY id`,
        [failedId, unknownId],
      );
      const failed = backfilled.rows.find((row) => row.id === failedId)!;
      const unknown = backfilled.rows.find((row) => row.id === unknownId)!;

      expect(failed.state).toBe('failed');
      expect(failed.dispatch_max_attempts).toBe(5);
      expect(failed.next_attempt_at?.toISOString()).toBe(
        '2026-01-01T00:01:00.000Z',
      );
      expect(unknown.state).toBe('unknown');
      expect(unknown.dispatch_max_attempts).toBe(4);
      expect(unknown.next_attempt_at?.toISOString()).toBe(
        '2026-01-01T01:15:00.000Z',
      );

      const claimAt = async (id: string, at: Date) =>
        client.query<{ id: string }>(
          `UPDATE notification_outbox
              SET dispatch_claim_token=$3,
                  dispatch_claimed_at=$4,
                  dispatch_claim_expires_at=$4 + interval '1 minute',
                  dispatch_attempt_count=dispatch_attempt_count + 1,
                  dispatch_last_attempt_at=$4,
                  next_attempt_at=NULL
            WHERE clinic_id=$1
              AND id=$2
              AND state IN ('failed', 'unknown')
              AND dispatch_attempt_count < dispatch_max_attempts
              AND next_attempt_at <= $4
              AND dispatch_claim_token IS NULL
            RETURNING id`,
          [clinicId, id, randomUUID(), at],
        );

      const failedDeadline = failed.next_attempt_at!;
      const unknownDeadline = unknown.next_attempt_at!;
      expect(
        (await claimAt(failedId, new Date(failedDeadline.getTime() - 1))).rowCount,
      ).toBe(0);
      expect((await claimAt(failedId, failedDeadline)).rowCount).toBe(1);
      expect(
        (await claimAt(unknownId, new Date(unknownDeadline.getTime() - 1)))
          .rowCount,
      ).toBe(0);
      expect((await claimAt(unknownId, unknownDeadline)).rowCount).toBe(1);
    } finally {
      await client.query('RESET search_path').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(
        () => undefined,
      );
      await client.end();
    }
  });
});
