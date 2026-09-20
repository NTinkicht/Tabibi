import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';
import { NotificationDeadLetterObservabilityRepository } from '@/modules/notification-outbox/observability';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const clinicA = randomUUID();
const clinicB = randomUUID();

beforeAll(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE notification_outbox, clinics CASCADE');
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name)
     VALUES ($1, 'wu39-a', 'WU39 A'), ($2, 'wu39-b', 'WU39 B')`,
    [clinicA, clinicB],
  );
});
afterAll(async () => pool.end());

async function enqueue(
  clinicId: string,
  key: string,
  eventKey = 'turn_approaching',
  queueEntryId: string | null = null,
) {
  return new NotificationOutboxRepository(pool).enqueue({
    clinicId,
    queueEntryId,
    logicalTargetKey: `queue-entry:${key}`,
    eventKey,
    intentVersion: 1,
    idempotencyKey: key,
    payload: { locale: 'fr', places: 2 },
  });
}

// Builds the minimal real queue-entry chain (doctor, session, patient) so a
// dead letter can reference an actual `public_display_label` -- the same
// privacy-safe, receptionist-facing code shown on the live queue board.
// The label itself is server-assigned (queue_entries_assign_public_display_label
// trigger), so this returns the assigned value rather than accepting one.
async function createQueueEntry(
  clinicId: string,
): Promise<{ id: string; label: string }> {
  const doctorUserId = randomUUID();
  const doctorId = randomUUID();
  const sessionId = randomUUID();
  const patientId = randomUUID();
  const queueEntryId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name)
     VALUES ($1, $2, 'WU39 Doctor')`,
    [doctorUserId, `wu39-doctor-${doctorUserId}`],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name)
     VALUES ($1, $2, 'WU39 Doctor')`,
    [doctorId, doctorUserId],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
    [clinicId, doctorId],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES ($1, $2, $3, '2026-09-13', '2026-09-13T08:00Z', '2026-09-13T12:00Z', 'open')`,
    [sessionId, clinicId, doctorId],
  );
  await pool.query(
    `INSERT INTO patient_operational_records (id, clinic_id, private_display_name)
     VALUES ($1, $2, 'WU39 Patient')`,
    [patientId, clinicId],
  );
  const inserted = await pool.query<{ public_display_label: string }>(
    `INSERT INTO queue_entries
       (id, clinic_id, session_id, patient_id, state, source, registration_order,
        public_display_label)
     VALUES ($1, $2, $3, $4, 'waiting', 'walk_in', 1, 'placeholder')
     RETURNING public_display_label`,
    [queueEntryId, clinicId, sessionId, patientId],
  );
  return { id: queueEntryId, label: inserted.rows[0]!.public_display_label };
}

async function deadLetter(
  clinicId: string,
  key: string,
  outcomeCode: string,
  outcomeAt: string,
  queueEntryId: string | null = null,
) {
  const repository = new NotificationOutboxRepository(pool);
  const intent = await enqueue(clinicId, key, 'turn_approaching', queueEntryId);
  await pool.query(
    'UPDATE notification_outbox SET dispatch_max_attempts=1 WHERE id=$1',
    [intent.id],
  );
  const claim = await repository.claimPendingIntent({
    clinicId,
    intentId: intent.id,
    leaseMs: 60_000,
  });
  expect(claim).not.toBeNull();
  await repository.completeDispatchAttempt({
    clinicId,
    intentId: intent.id,
    claimToken: claim!.claimToken,
    outcome: 'failed',
    outcomeCode,
  });
  await pool.query(
    'UPDATE notification_outbox SET dispatch_outcome_at=$2 WHERE id=$1',
    [intent.id, outcomeAt],
  );
  return intent;
}

describe('notification dead-letter observability', () => {
  it('returns only bounded privacy-minimal dead letters for the requested clinic', async () => {
    const older = await deadLetter(
      clinicA,
      'wu39-a-old',
      'provider_timeout',
      '2026-09-13T10:00:00Z',
    );
    const newer = await deadLetter(
      clinicA,
      'wu39-a-new',
      'provider_unknown',
      '2026-09-13T11:00:00Z',
    );
    await deadLetter(
      clinicB,
      'wu39-b-private',
      'other_clinic_failure',
      '2026-09-13T12:00:00Z',
    );
    await enqueue(clinicA, 'wu39-pending');

    const repository = new NotificationDeadLetterObservabilityRepository(pool);
    const records = await repository.listRecentForClinic({
      clinicId: clinicA,
      limit: 1,
    });

    expect(records).toEqual([
      {
        intentId: newer.id,
        eventKey: 'turn_approaching',
        queueLabel: null,
        outcomeCode: 'provider_unknown',
        attemptCount: 1,
        maxAttempts: 1,
        outcomeAt: '2026-09-13T11:00:00.000Z',
      },
    ]);
    expect(records[0]).not.toHaveProperty('payload');
    expect(records[0]).not.toHaveProperty('logicalTargetKey');
    expect(records[0]).not.toHaveProperty('idempotencyKey');
    expect(records[0]).not.toHaveProperty('claimToken');

    const allClinicA = await repository.listRecentForClinic({
      clinicId: clinicA,
    });
    expect(allClinicA.map((record) => record.intentId)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it('rejects invalid scope and unbounded limits before querying', async () => {
    const repository = new NotificationDeadLetterObservabilityRepository(pool);

    await expect(
      repository.listRecentForClinic({ clinicId: '   ' }),
    ).rejects.toThrow('clinicId is required');
    await expect(
      repository.listRecentForClinic({ clinicId: clinicA, limit: 101 }),
    ).rejects.toThrow('limit must be an integer between 1 and 100');
  });

  it('resolves the privacy-safe receptionist queue label for a dead letter tied to a real entry, isolated by clinic', async () => {
    const entryA = await createQueueEntry(clinicA);
    const entryB = await createQueueEntry(clinicB);
    const withLabel = await deadLetter(
      clinicA,
      'wu39-a-labelled',
      'provider_unknown',
      '2026-09-13T13:00:00Z',
      entryA.id,
    );
    await deadLetter(
      clinicB,
      'wu39-b-labelled',
      'provider_unknown',
      '2026-09-13T13:00:00Z',
      entryB.id,
    );

    const repository = new NotificationDeadLetterObservabilityRepository(pool);
    const records = await repository.listRecentForClinic({
      clinicId: clinicA,
      limit: 1,
    });

    expect(records).toEqual([
      expect.objectContaining({
        intentId: withLabel.id,
        queueLabel: entryA.label,
      }),
    ]);
    // Never the other clinic's label, and never a raw queue_entry_id.
    expect(JSON.stringify(records)).not.toContain(entryB.label);
    expect(JSON.stringify(records)).not.toContain(entryA.id);
    expect(JSON.stringify(records)).not.toContain(entryB.id);
  });
});
