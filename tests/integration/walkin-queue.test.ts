import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AuthorizationError } from '@/modules/identity';
import {
  publicQueueEntry,
  QueueConflictError,
  QueueService,
} from '@/modules/queue';
import { SessionService } from '@/modules/session';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 16 });

const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  receptionistA: randomUUID(),
  receptionistB: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
};

const scopeA = { clinicId: ids.clinicA, actorUserId: ids.receptionistA };
const scopeB = { clinicId: ids.clinicB, actorUserId: ids.receptionistB };

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_registration_receipts, queue_entries,
    patient_operational_records, session_command_receipts, consultation_sessions,
    schedule_templates, doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
      ($1, 'walkin-reception-a', 'Reception A'),
      ($2, 'walkin-reception-b', 'Reception B'),
      ($3, 'walkin-doctor', 'Doctor')`,
    [ids.receptionistA, ids.receptionistB, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
      ($1, 'walkin-clinic-a', 'Clinic A'),
      ($2, 'walkin-clinic-b', 'Clinic B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
      ($1, $3, 'receptionist'),
      ($2, $4, 'receptionist'),
      ($1, $5, 'doctor')`,
    [
      ids.clinicA,
      ids.clinicB,
      ids.receptionistA,
      ids.receptionistB,
      ids.doctorUser,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
    [ids.clinicA, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id, clinic_id, doctor_id, service_date, starts_at, ends_at)
     VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + time '09:00', CURRENT_DATE + time '12:00')`,
    [ids.session, ids.clinicA, ids.doctor],
  );
});

afterAll(async () => pool.end());

function input(name: string, key: string) {
  return {
    privateDisplayName: name,
    preferredLocale: 'ar' as const,
    idempotencyKey: key,
    correlationId: `test-${key}`,
  };
}

describe('walk-in registration foundation', () => {
  it('registers a contact-less patient as waiting without exposing PII in the public representation', async () => {
    const queue = new QueueService(pool);
    const registration = await queue.registerWalkIn(
      scopeA,
      ids.session,
      input('Nadia B.', 'contactless-1'),
    );

    expect(registration.patient).toMatchObject({
      privateDisplayName: 'Nadia B.',
      preferredLocale: 'ar',
      hasContact: false,
    });
    expect(registration.entry).toMatchObject({
      sessionId: ids.session,
      state: 'waiting',
      registrationOrder: 1,
      eligibilityOrder: null,
      priorityOrder: null,
    });
    expect(registration.entry.publicDisplayLabel).toMatch(/^W-[A-F0-9]{10}$/);

    const listed = await queue.listWaiting(scopeA, ids.session);
    expect(listed).toHaveLength(1);
    const publicView = publicQueueEntry(listed[0]!);
    expect(publicView).toEqual({
      state: 'waiting',
      publicDisplayLabel: registration.entry.publicDisplayLabel,
    });
    expect(JSON.stringify(publicView)).not.toContain('Nadia');

    const stored = await pool.query<{
      contact_phone: string | null;
      contact_email: string | null;
    }>('SELECT contact_phone, contact_email FROM patient_operational_records');
    expect(stored.rows[0]).toEqual({
      contact_phone: null,
      contact_email: null,
    });
  });

  it('stores optional contact privately but creates no guest remote credential', async () => {
    const queue = new QueueService(pool);
    const registration = await queue.registerWalkIn(scopeA, ids.session, {
      ...input('Karim A.', 'contact-1'),
      contactPhone: '+213555000001',
      contactEmail: 'PatientID@EXAMPLE.dz',
      preferredLocale: 'fr',
    });
    expect(registration.patient.hasContact).toBe(true);
    const stored = await pool.query<{
      contact_phone: string | null;
      contact_email: string | null;
    }>(
      'SELECT contact_phone, contact_email FROM patient_operational_records WHERE id = $1',
      [registration.patient.id],
    );
    expect(stored.rows[0]).toEqual({
      contact_phone: '+213555000001',
      contact_email: 'PatientID@example.dz',
    });
    const credentialTables = await pool.query<{
      bearer: string | null;
      exchange: string | null;
    }>(
      `SELECT to_regclass('guest_credentials')::text bearer,
              to_regclass('guest_exchange_ids')::text exchange`,
    );
    expect(credentialTables.rows[0]).toEqual({ bearer: null, exchange: null });
  });

  it('stores the patient locale selected independently from the staff interface', async () => {
    const queue = new QueueService(pool);
    const registration = await queue.registerWalkIn(scopeA, ids.session, {
      ...input('Patient arabophone', 'cross-locale'),
      preferredLocale: 'ar',
    });

    expect(registration.patient.preferredLocale).toBe('ar');
    const stored = await pool.query<{ preferred_locale: string }>(
      'SELECT preferred_locale FROM patient_operational_records WHERE id = $1',
      [registration.patient.id],
    );
    expect(stored.rows[0]?.preferred_locale).toBe('ar');
  });

  it('returns the same records on exact retry, rejects key reuse with different content, and reauthorizes retries', async () => {
    const queue = new QueueService(pool);
    const first = await queue.registerWalkIn(
      scopeA,
      ids.session,
      input('Amel', 'retry-1'),
    );
    const retry = await queue.registerWalkIn(
      scopeA,
      ids.session,
      input('Amel', 'retry-1'),
    );
    expect(retry).toEqual(first);

    await expect(
      queue.registerWalkIn(scopeA, ids.session, input('Different', 'retry-1')),
    ).rejects.toBeInstanceOf(QueueConflictError);

    const counts = await pool.query<{
      patients: string;
      entries: string;
      audits: string;
    }>(
      `SELECT
        (SELECT count(*) FROM patient_operational_records)::text patients,
        (SELECT count(*) FROM queue_entries)::text entries,
        (SELECT count(*) FROM audit_events WHERE action = 'walk_in_registered')::text audits`,
    );
    expect(counts.rows[0]).toEqual({
      patients: '1',
      entries: '1',
      audits: '1',
    });

    const audit = await pool.query<{ metadata: string }>(
      `SELECT metadata::text FROM audit_events WHERE action = 'walk_in_registered'`,
    );
    expect(audit.rows[0]!.metadata).not.toContain('Amel');

    await pool.query(
      'DELETE FROM clinic_memberships WHERE clinic_id = $1 AND user_id = $2',
      [ids.clinicA, ids.receptionistA],
    );
    await expect(
      queue.registerWalkIn(scopeA, ids.session, input('Amel', 'retry-1')),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('serializes concurrent registrations into distinct contiguous immutable order values', async () => {
    const queue = new QueueService(pool);
    const registrations = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        queue.registerWalkIn(
          scopeA,
          ids.session,
          input(`Walk-in ${index + 1}`, `concurrent-${index + 1}`),
        ),
      ),
    );
    expect(
      registrations
        .map((item) => item.entry.registrationOrder)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      new Set(registrations.map((item) => item.entry.publicDisplayLabel)).size,
    ).toBe(8);
  });

  it('rejects unauthorized, cross-clinic, and terminal-session registration', async () => {
    const queue = new QueueService(pool);
    await expect(
      queue.registerWalkIn(
        { clinicId: ids.clinicA, actorUserId: ids.doctorUser },
        ids.session,
        input('Doctor attempt', 'doctor-attempt'),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    await expect(
      queue.registerWalkIn(
        scopeB,
        ids.session,
        input('Cross clinic', 'cross-clinic'),
      ),
    ).rejects.toBeInstanceOf(QueueConflictError);

    await pool.query(
      `UPDATE consultation_sessions SET status = 'closed' WHERE id = $1`,
      [ids.session],
    );
    await expect(
      queue.registerWalkIn(scopeA, ids.session, input('Too late', 'terminal')),
    ).rejects.toBeInstanceOf(QueueConflictError);
  });

  it('never commits an active waiting row into a closed session during a registration race', async () => {
    await pool.query(
      `UPDATE consultation_sessions SET status = 'open' WHERE id = $1`,
      [ids.session],
    );
    const queue = new QueueService(pool);
    const sessions = new SessionService(pool);
    await Promise.allSettled([
      queue.registerWalkIn(
        scopeA,
        ids.session,
        input('Race patient', 'race-close-register'),
      ),
      sessions.command(scopeA, ids.session, {
        command: 'close',
        idempotencyKey: 'race-close-command',
        correlationId: 'race-close',
      }),
    ]);
    const state = await pool.query<{ status: string; waiting: string }>(
      `SELECT session.status,
              (SELECT count(*) FROM queue_entries q WHERE q.session_id = session.id AND q.state = 'waiting')::text waiting
         FROM consultation_sessions session WHERE session.id = $1`,
      [ids.session],
    );
    expect(
      state.rows[0]!.status === 'closed' && state.rows[0]!.waiting !== '0',
    ).toBe(false);
  });

  it('cancels a concurrently registered waiting entry or rejects registration after session cancellation', async () => {
    await pool.query(
      `UPDATE consultation_sessions SET status = 'open' WHERE id = $1`,
      [ids.session],
    );
    const queue = new QueueService(pool);
    const sessions = new SessionService(pool);
    await Promise.allSettled([
      queue.registerWalkIn(
        scopeA,
        ids.session,
        input('Cancel race', 'race-cancel-register'),
      ),
      sessions.command(scopeA, ids.session, {
        command: 'cancel',
        reason: 'Clinic cancelled the session',
        idempotencyKey: 'race-cancel-command',
        correlationId: 'race-cancel',
      }),
    ]);
    const state = await pool.query<{ status: string; active: string }>(
      `SELECT session.status,
              (SELECT count(*) FROM queue_entries q
                WHERE q.session_id = session.id AND q.state IN ('waiting','checked_in','called'))::text active
         FROM consultation_sessions session WHERE session.id = $1`,
      [ids.session],
    );
    expect(state.rows[0]).toEqual({ status: 'cancelled', active: '0' });
  });

  it('atomically audits every entry cancelled with a session', async () => {
    const queue = new QueueService(pool);
    const sessions = new SessionService(pool);
    const registrations = await Promise.all(
      ['waiting', 'checked-in', 'called'].map((label, index) =>
        queue.registerWalkIn(
          scopeA,
          ids.session,
          input(label, `cancel-audit-${index}`),
        ),
      ),
    );
    await pool.query(
      `UPDATE queue_entries
          SET state = CASE id
            WHEN $1 THEN 'checked_in'::queue_entry_status
            WHEN $2 THEN 'called'::queue_entry_status
            ELSE state
          END,
          eligibility_order = CASE id WHEN $1 THEN 1 ELSE NULL END
        WHERE session_id = $3`,
      [registrations[1]!.entry.id, registrations[2]!.entry.id, ids.session],
    );
    await pool.query(
      `UPDATE consultation_sessions SET status = 'open' WHERE id = $1`,
      [ids.session],
    );

    await sessions.command(scopeA, ids.session, {
      command: 'cancel',
      reason: 'Doctor unavailable',
      idempotencyKey: 'multi-entry-cancel',
      correlationId: 'multi-entry-cancel-correlation',
    });

    const audits = await pool.query<{
      actor_user_id: string;
      entity_type: string;
      entity_id: string;
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, entity_type, entity_id, action, metadata
         FROM audit_events
        WHERE action IN ('consultation_session.cancel', 'queue_entry.cancelled_by_session')
        ORDER BY entity_type, entity_id`,
    );
    expect(audits.rows).toHaveLength(4);
    const entryAudits = audits.rows.filter(
      (audit) => audit.action === 'queue_entry.cancelled_by_session',
    );
    expect(entryAudits.map((audit) => audit.entity_id).sort()).toEqual(
      registrations.map((registration) => registration.entry.id).sort(),
    );
    expect(entryAudits.map((audit) => audit.metadata.from).sort()).toEqual([
      'called',
      'checked_in',
      'waiting',
    ]);
    for (const audit of audits.rows) {
      expect(audit.actor_user_id).toBe(ids.receptionistA);
      expect(audit.metadata).toMatchObject({
        reason: 'Doctor unavailable',
        correlationId: 'multi-entry-cancel-correlation',
        idempotencyKey: 'multi-entry-cancel',
      });
    }
    const entries = await pool.query<{ state: string }>(
      'SELECT state FROM queue_entries WHERE session_id = $1',
      [ids.session],
    );
    expect(entries.rows).toHaveLength(3);
    expect(entries.rows.every((entry) => entry.state === 'cancelled')).toBe(
      true,
    );
  });
});
