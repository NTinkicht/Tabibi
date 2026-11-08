import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { closePool } from '@/platform/database/pool';
import { QueueService } from '@/modules/queue';
import { createStaffSessionToken } from '@/platform/http/staff-auth';
import { POST as createSession } from '@/app/api/clinics/[clinicId]/sessions/route';
import { POST as sessionCommand } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/commands/route';
import { POST as sessionDelay } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/delay/route';
import {
  GET as listQueue,
  POST as registerWalkIn,
} from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/route';
import { POST as entryCommand } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/commands/route';
import { POST as restoreEntry } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/restore/route';
import { POST as transferEntry } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/transfer/route';
import { POST as reorder } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/reorder/route';
import { GET as dashboard } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/dashboard/route';

// TAB-P0-01 (#769 follow-up), session and queue family: service-level role
// checks with VALID payloads against a seeded clinic-A session and queue.
// The generic matrix (#767) sends `{}` bodies, so a 400/404 could mask a
// missing requireClinicRole. Session create is receptionist/clinic_admin,
// session commands and delay are the owning doctor, receptionist and
// clinic_admin, queue operations are receptionist/clinic_admin only, except
// that the owning doctor may read the dashboard and call / start / complete /
// no-show and reorder on their own session (owner decisions #799 and #817, covered in
// doctor-queue-authorization.test.ts). A
// clinic-B admin must also fail through its OWN clinic path with the clinic-A
// session id (IDOR), without any state change.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ORIGIN = 'http://localhost';
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  adminA: randomUUID(),
  adminB: randomUUID(),
  receptionistA: randomUUID(),
  doctorA: randomUUID(),
  doctorA2: randomUUID(),
  profileA: randomUUID(),
  profileA2: randomUUID(),
  session: randomUUID(),
};
const subjects = {
  adminA: 'sq-admin-a',
  adminB: 'sq-admin-b',
  receptionistA: 'sq-reception-a',
  doctorA: 'sq-doctor-a',
  doctorA2: 'sq-doctor-a2',
};
const entries: string[] = [];
let keySeq = 0;

async function cookieFor(subject: string): Promise<string> {
  const token = await createStaffSessionToken(
    subject,
    new Date(Date.now() + 60_000),
  );
  return `tabibi_staff_session=${token}`;
}

function request(url: string, method: string, cookie: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'idempotency-key': `sq-${++keySeq}`,
      cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const sessionPath = (clinicId = ids.clinicA) =>
  `${ORIGIN}/api/clinics/${clinicId}/sessions/${ids.session}`;
const sessionCtx = (clinicId = ids.clinicA) => ({
  params: Promise.resolve({ clinicId, sessionId: ids.session }),
});
const entryCtx = (entryId: string, clinicId = ids.clinicA) => ({
  params: Promise.resolve({ clinicId, sessionId: ids.session, entryId }),
});

async function status(promise: Promise<Response>): Promise<number> {
  return (await promise).status;
}

async function sessionRow() {
  const r = await pool.query<{ status: string; delay: number | null }>(
    `SELECT status, declared_delay_minutes AS delay FROM consultation_sessions WHERE id = $1`,
    [ids.session],
  );
  return r.rows[0]!;
}

async function count(table: string): Promise<number> {
  const r = await pool.query(`SELECT 1 FROM ${table} WHERE clinic_id = $1`, [
    ids.clinicA,
  ]);
  return r.rowCount ?? 0;
}

async function entryStates(): Promise<string[]> {
  const r = await pool.query<{ state: string }>(
    `SELECT state FROM queue_entries WHERE clinic_id = $1 ORDER BY id`,
    [ids.clinicA],
  );
  return r.rows.map((row) => row.state);
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'cross-tenant-sessions-queue-secret-at-least-32-chars';
  await migrate();
  await pool.query(
    `TRUNCATE audit_events, staff_sessions, queue_command_receipts,
       queue_registration_receipts, queue_entries, patient_operational_records,
       session_command_receipts, consultation_sessions, schedule_templates,
       clinic_memberships, doctor_clinics, doctor_profiles, clinics, users CASCADE`,
  );
  for (const [key, subject] of Object.entries(subjects)) {
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $2)`,
      [ids[key as keyof typeof subjects], subject],
    );
  }
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'sq-a', 'A'), ($2, 'sq-b', 'B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($2, $4, 'clinic_admin'), ($1, $5, 'receptionist'),
       ($1, $6, 'doctor'), ($1, $7, 'doctor')`,
    [
      ids.clinicA,
      ids.clinicB,
      ids.adminA,
      ids.adminB,
      ids.receptionistA,
      ids.doctorA,
      ids.doctorA2,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
       ($1, $3, 'Dr A'), ($2, $4, 'Dr A2')`,
    [ids.profileA, ids.profileA2, ids.doctorA, ids.doctorA2],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2), ($1, $3)`,
    [ids.clinicA, ids.profileA, ids.profileA2],
  );
  await pool.query(
    `INSERT INTO consultation_sessions (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + time '09:00', CURRENT_DATE + time '12:00', 'open')`,
    [ids.session, ids.clinicA, ids.profileA],
  );
  const queue = new QueueService(pool);
  for (let i = 0; i < 2; i++) {
    const item = await queue.registerWalkIn(
      { clinicId: ids.clinicA, actorUserId: ids.receptionistA },
      ids.session,
      {
        privateDisplayName: `Patient ${i}`,
        preferredLocale: 'fr',
        idempotencyKey: `sq-seed-${i}`,
        correlationId: `sq-seed-${i}`,
      },
    );
    entries.push(item.entry.id);
  }
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('session routes enforce the target clinic role', () => {
  const body = {
    doctorId: ids.profileA,
    serviceDate: '2027-03-03',
    startsAt: '2027-03-03T10:00:00.000Z',
    endsAt: '2027-03-03T11:00:00.000Z',
  };
  const create = async (subject: string) =>
    status(
      createSession(
        request(
          `${ORIGIN}/api/clinics/${ids.clinicA}/sessions`,
          'POST',
          await cookieFor(subject),
          body,
        ),
        { params: Promise.resolve({ clinicId: ids.clinicA }) },
      ),
    );

  it('manual session create is 403 for a clinic-B admin and both clinic-A doctors, creating nothing', async () => {
    for (const s of [subjects.adminB, subjects.doctorA, subjects.doctorA2])
      expect(await create(s), s).toBe(403);
    expect(await count('consultation_sessions')).toBe(1);
  });

  it('session commands and delay are denied across clinics and to a non-owning doctor, changing nothing', async () => {
    const command = async (subject: string, clinicId = ids.clinicA) =>
      status(
        sessionCommand(
          request(
            `${sessionPath(clinicId)}/commands`,
            'POST',
            await cookieFor(subject),
            { command: 'pause' },
          ),
          sessionCtx(clinicId),
        ),
      );
    const delay = async (subject: string, clinicId = ids.clinicA) =>
      status(
        sessionDelay(
          request(
            `${sessionPath(clinicId)}/delay`,
            'POST',
            await cookieFor(subject),
            { command: 'declare_delay', minutes: 15, expectedVersion: 0 },
          ),
          sessionCtx(clinicId),
        ),
      );
    expect(await command(subjects.adminB)).toBe(403);
    expect(await command(subjects.doctorA2)).toBe(403);
    expect(await delay(subjects.adminB)).toBe(403);
    expect(await delay(subjects.doctorA2)).toBe(403);
    // Own clinic path with the clinic-A session id: not found in that clinic.
    expect(await command(subjects.adminB, ids.clinicB)).toBe(409);
    expect(await delay(subjects.adminB, ids.clinicB)).toBe(409);
    expect(await sessionRow()).toEqual({ status: 'open', delay: null });

    // The owning doctor, receptionist and clinic admin succeed.
    expect(await command(subjects.doctorA)).toBe(200);
    expect((await sessionRow()).status).toBe('paused');
    expect(
      await status(
        sessionCommand(
          request(
            `${sessionPath()}/commands`,
            'POST',
            await cookieFor(subjects.receptionistA),
            { command: 'resume' },
          ),
          sessionCtx(),
        ),
      ),
    ).toBe(200);
    expect(await delay(subjects.adminA)).toBe(200);
    expect((await sessionRow()).delay).toBe(15);
  });
});

describe('queue routes enforce the target clinic role', () => {
  const register = async (subject: string, clinicId = ids.clinicA) =>
    status(
      registerWalkIn(
        request(
          `${sessionPath(clinicId)}/queue`,
          'POST',
          await cookieFor(subject),
          { privateDisplayName: 'Intruder', preferredLocale: 'ar' },
        ),
        sessionCtx(clinicId),
      ),
    );

  it('walk-in registration and queue/dashboard reads are denied to other clinics and doctors', async () => {
    const before = await count('queue_entries');
    for (const s of [subjects.adminB, subjects.doctorA, subjects.doctorA2])
      expect(await register(s), s).toBe(403);
    expect(await register(subjects.adminB, ids.clinicB)).toBeGreaterThanOrEqual(
      400,
    );
    expect(await count('queue_entries')).toBe(before);

    for (const handler of [listQueue, dashboard]) {
      const url =
        handler === listQueue
          ? `${sessionPath()}/queue`
          : `${sessionPath()}/dashboard`;
      // Owner decision #799: the OWNING doctor may read the dashboard of this
      // session; the queue list stays receptionist/clinic_admin only, and a
      // non-owning doctor or another clinic is denied both.
      const denied =
        handler === listQueue
          ? [subjects.adminB, subjects.doctorA, subjects.doctorA2]
          : [subjects.adminB, subjects.doctorA2];
      for (const s of denied)
        expect(
          await status(
            handler(
              request(url, 'GET', await cookieFor(s)),
              sessionCtx() as never,
            ),
          ),
          s,
        ).toBe(403);
      if (handler === dashboard)
        expect(
          await status(
            handler(
              request(url, 'GET', await cookieFor(subjects.doctorA)),
              sessionCtx() as never,
            ),
          ),
        ).toBe(200);
      expect(
        await status(
          handler(
            request(url, 'GET', await cookieFor(subjects.receptionistA)),
            sessionCtx() as never,
          ),
        ),
      ).toBe(200);
    }
  });

  it('entry commands and reorder are denied to other clinics and doctors, changing nothing', async () => {
    const states = await entryStates();
    for (const s of [subjects.adminB, subjects.doctorA, subjects.doctorA2]) {
      expect(
        await status(
          entryCommand(
            request(
              `${sessionPath()}/queue/${entries[0]}/commands`,
              'POST',
              await cookieFor(s),
              { command: 'check_in' },
            ),
            entryCtx(entries[0]!),
          ),
        ),
        s,
      ).toBe(403);
      // Owner decision #817: the OWNING doctor may reorder (covered in
      // doctor-queue-authorization.test.ts); everyone else here is denied.
      if (s === subjects.doctorA) continue;
      expect(
        await status(
          reorder(
            request(
              `${sessionPath()}/queue/${entries[1]}/reorder`,
              'POST',
              await cookieFor(s),
              { targetPosition: 1, expectedVersion: 0, reason: 'urgent' },
            ),
            entryCtx(entries[1]!),
          ),
        ),
        s,
      ).toBe(403);
    }
    // IDOR through the attacker's own clinic path: never a success.
    const idor = await status(
      entryCommand(
        request(
          `${sessionPath(ids.clinicB)}/queue/${entries[0]}/commands`,
          'POST',
          await cookieFor(subjects.adminB),
          { command: 'check_in' },
        ),
        entryCtx(entries[0]!, ids.clinicB),
      ),
    );
    expect(idor).toBeGreaterThanOrEqual(400);
    expect(idor).toBeLessThan(500);
    expect(await entryStates()).toEqual(states);
  });

  it('walk-in restore is denied to other clinics and doctors, allowed to reception', async () => {
    await pool.query(
      `UPDATE queue_entries SET state='cancelled' WHERE id = $1`,
      [entries[0]],
    );
    const states = await entryStates();
    const restoreRequest = async (subject: string, clinicId = ids.clinicA) =>
      restoreEntry(
        request(
          `${sessionPath(clinicId)}/queue/${entries[0]}/restore`,
          'POST',
          await cookieFor(subject),
          { reason: 'Cancelled by mistake' },
        ),
        entryCtx(entries[0]!, clinicId),
      );
    for (const s of [subjects.adminB, subjects.doctorA, subjects.doctorA2])
      expect(await status(restoreRequest(s)), s).toBe(403);
    const idor = await status(restoreRequest(subjects.adminB, ids.clinicB));
    expect(idor).toBeGreaterThanOrEqual(400);
    expect(idor).toBeLessThan(500);
    expect(await entryStates()).toEqual(states);
    // Positive control: the same payload succeeds for clinic-A reception.
    expect(await status(restoreRequest(subjects.receptionistA))).toBe(200);
    const r = await pool.query<{ state: string }>(
      `SELECT state FROM queue_entries WHERE id = $1`,
      [entries[0]],
    );
    expect(r.rows[0]!.state).toBe('waiting');
  });

  it('the receptionist and clinic admin succeed with valid payloads', async () => {
    expect(await register(subjects.receptionistA)).toBe(201);
    expect(await register(subjects.adminA)).toBe(201);
    expect(await count('queue_entries')).toBe(4);
    expect(
      await status(
        entryCommand(
          request(
            `${sessionPath()}/queue/${entries[0]}/commands`,
            'POST',
            await cookieFor(subjects.receptionistA),
            { command: 'check_in' },
          ),
          entryCtx(entries[0]!),
        ),
      ),
    ).toBe(200);
    const r = await pool.query<{ state: string }>(
      `SELECT state FROM queue_entries WHERE id = $1`,
      [entries[0]],
    );
    expect(r.rows[0]!.state).toBe('checked_in');
  });

  it('walk-in transfer is denied to other clinics and doctors, allowed to reception', async () => {
    const targetId = randomUUID();
    await pool.query(
      `INSERT INTO consultation_sessions (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
       VALUES ($1, $2, $3, CURRENT_DATE + 1, CURRENT_DATE + 1 + time '09:00', CURRENT_DATE + 1 + time '12:00', 'planned')`,
      [targetId, ids.clinicA, ids.profileA],
    );
    const states = await entryStates();
    const transferRequest = async (subject: string, clinicId = ids.clinicA) =>
      transferEntry(
        request(
          `${sessionPath(clinicId)}/queue/${entries[0]}/transfer`,
          'POST',
          await cookieFor(subject),
          { reason: 'Doctor moved', targetSessionId: targetId },
        ),
        entryCtx(entries[0]!, clinicId),
      );
    for (const s of [subjects.adminB, subjects.doctorA, subjects.doctorA2])
      expect(await status(transferRequest(s)), s).toBe(403);
    const idor = await status(transferRequest(subjects.adminB, ids.clinicB));
    expect(idor).toBeGreaterThanOrEqual(400);
    expect(idor).toBeLessThan(500);
    expect(await entryStates()).toEqual(states);
    // Positive control: the same payload succeeds for clinic-A reception.
    expect(await status(transferRequest(subjects.receptionistA))).toBe(200);
    const r = await pool.query<{ state: string }>(
      `SELECT state FROM queue_entries WHERE id = $1`,
      [entries[0]],
    );
    expect(r.rows[0]!.state).toBe('cancelled');
  });
});
