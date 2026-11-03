import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { GET } from '@/app/api/clinics/[clinicId]/notifications/guest-link-failures/route';
import { GuestLinkFailureObservabilityRepository } from '@/modules/guest-access/link-failure-observability';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  receptionist: randomUUID(),
};
const authSubject = 'tab753-reception';
const secret = 'tab753-api-test-session-secret-at-least-32-characters';

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET = secret;
  await migrate();
});

beforeEach(async () => {
  await pool.query(
    'TRUNCATE guest_link_intents, clinic_memberships, clinics, users CASCADE',
  );
  await pool.query(
    `INSERT INTO users(id, auth_subject, display_name)
     VALUES ($1, $2, 'TAB753 Reception')`,
    [ids.receptionist, authSubject],
  );
  await pool.query(
    `INSERT INTO clinics(id, tenant_key, name) VALUES
      ($1, 'tab753-a', 'TAB753 A'), ($2, 'tab753-b', 'TAB753 B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id, user_id, role)
     VALUES ($1, $2, 'receptionist')`,
    [ids.clinicA, ids.receptionist],
  );
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

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
     VALUES ($1, $2, 'TAB753 Doctor')`,
    [doctorUserId, `tab753-doctor-${doctorUserId}`],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name)
     VALUES ($1, $2, 'TAB753 Doctor')`,
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
     VALUES ($1, $2, 'TAB753 Patient')`,
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

/** Inserts an intent directly in a lifecycle state the table CHECKs allow. */
async function intent(
  clinicId: string,
  queueEntryId: string,
  state: 'pending' | 'delivered' | 'dead_letter' | 'expired',
  scrubbedAt: string | null,
  attempts = 0,
  kind = 'initial',
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO guest_link_intents
       (id, clinic_id, queue_entry_id, intent, state, envelope_ciphertext,
        created_at, expires_at, scrubbed_at, attempts)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-09-13T09:00Z', '2026-09-13T09:05Z', $7, $8)`,
    [
      id,
      clinicId,
      queueEntryId,
      kind,
      state,
      state === 'pending' ? 'secret-envelope-ciphertext' : null,
      scrubbedAt,
      attempts,
    ],
  );
  return id;
}

async function request(clinicId: string, query = '', authenticated = true) {
  const cookie = `tabibi_staff_session=${await createStaffSessionToken(
    authSubject,
    new Date(Date.now() + 60_000),
  )}`;
  return new Request(
    `http://localhost/api/clinics/${clinicId}/notifications/guest-link-failures${query}`,
    authenticated ? { headers: { cookie } } : undefined,
  );
}

const context = (clinicId: string) => ({
  params: Promise.resolve({ clinicId }),
});

describe('guest-link delivery failure escalation (TAB-P0-13, #753)', () => {
  it('lists only dead-lettered and expired intents of the clinic, newest first, with exact minimal shape', async () => {
    const entry = await createQueueEntry(ids.clinicA);
    const foreignEntry = await createQueueEntry(ids.clinicB);
    const older = await intent(
      ids.clinicA,
      entry.id,
      'expired',
      '2026-09-13T09:06:00Z',
      0,
      'transfer',
    );
    const newer = await intent(
      ids.clinicA,
      entry.id,
      'dead_letter',
      '2026-09-13T09:08:00Z',
      5,
    );
    await intent(ids.clinicA, entry.id, 'pending', null);
    await intent(ids.clinicA, entry.id, 'delivered', '2026-09-13T09:07:00Z', 1);
    await intent(
      ids.clinicB,
      foreignEntry.id,
      'dead_letter',
      '2026-09-13T09:09:00Z',
      5,
    );

    const records = await new GuestLinkFailureObservabilityRepository(
      pool,
    ).listRecentForClinic({ clinicId: ids.clinicA });

    expect(records).toEqual([
      {
        intentId: newer,
        intent: 'initial',
        state: 'dead_letter',
        queueLabel: entry.label,
        attempts: 5,
        outcomeAt: '2026-09-13T09:08:00.000Z',
      },
      {
        intentId: older,
        intent: 'transfer',
        state: 'expired',
        queueLabel: entry.label,
        attempts: 0,
        outcomeAt: '2026-09-13T09:06:00.000Z',
      },
    ]);
    const bounded = await new GuestLinkFailureObservabilityRepository(
      pool,
    ).listRecentForClinic({ clinicId: ids.clinicA, limit: 1 });
    expect(bounded.map((r) => r.intentId)).toEqual([newer]);
  });

  it('rejects invalid repository inputs before querying', async () => {
    const repository = new GuestLinkFailureObservabilityRepository(pool);
    await expect(
      repository.listRecentForClinic({ clinicId: ' ' }),
    ).rejects.toThrow(TypeError);
    for (const limit of [0, 101, 1.5, -1]) {
      await expect(
        repository.listRecentForClinic({ clinicId: ids.clinicA, limit }),
      ).rejects.toThrow(RangeError);
    }
  });

  it('rejects unauthenticated reads and fails closed without an allowed membership', async () => {
    const anonymous = await GET(
      await request(ids.clinicA, '', false),
      context(ids.clinicA),
    );
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('no-store');

    const foreign = await GET(await request(ids.clinicB), context(ids.clinicB));
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('cache-control')).toBe('no-store');
  });

  it('serves a bounded response that never contains link material, and rejects invalid limits', async () => {
    const entry = await createQueueEntry(ids.clinicA);
    await intent(
      ids.clinicA,
      entry.id,
      'dead_letter',
      '2026-09-13T09:08:00Z',
      5,
    );
    await intent(ids.clinicA, entry.id, 'pending', null);

    const response = await GET(
      await request(ids.clinicA, '?limit=5'),
      context(ids.clinicA),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as {
      failures: Array<Record<string, unknown>>;
    };
    expect(body.failures).toHaveLength(1);
    expect(Object.keys(body.failures[0]!).sort()).toEqual([
      'attempts',
      'intent',
      'intentId',
      'outcomeAt',
      'queueLabel',
      'state',
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret-envelope-ciphertext');
    expect(serialized).not.toContain(entry.id);

    for (const token of ['0', '101', '1.5', '+2', ' 2 ', '01', 'abc']) {
      const rejected = await GET(
        await request(ids.clinicA, `?limit=${encodeURIComponent(token)}`),
        context(ids.clinicA),
      );
      expect(rejected.status, token).toBe(400);
    }
  });
});
