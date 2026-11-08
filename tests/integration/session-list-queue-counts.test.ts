import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { closePool } from '@/platform/database/pool';
import { QueueService } from '@/modules/queue';
import { createStaffSessionToken } from '@/platform/http/staff-auth';
import { GET as listSessions } from '@/app/api/clinics/[clinicId]/sessions/route';

// Gap register G-17: the staff session list carries aggregate, non-identifying
// queue counts per session, under the existing role and doctor scoping.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ORIGIN = 'http://localhost';
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  receptionistA: randomUUID(),
  doctorA: randomUUID(),
  doctorA2: randomUUID(),
  adminB: randomUUID(),
  profileA: randomUUID(),
  profileA2: randomUUID(),
  session: randomUUID(),
  sessionA2: randomUUID(),
};
const subjects = {
  receptionistA: 'sc-reception-a',
  doctorA: 'sc-doctor-a',
  doctorA2: 'sc-doctor-a2',
  adminB: 'sc-admin-b',
};
let today = '';

async function get(
  subject: string,
  date: string,
  clinicId = ids.clinicA,
): Promise<{ status: number; body: unknown; text: string }> {
  const token = await createStaffSessionToken(
    subject,
    new Date(Date.now() + 60_000),
  );
  const response = await listSessions(
    new Request(`${ORIGIN}/api/clinics/${clinicId}/sessions?date=${date}`, {
      method: 'GET',
      headers: { origin: ORIGIN, cookie: `tabibi_staff_session=${token}` },
    }),
    { params: Promise.resolve({ clinicId }) },
  );
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text ? JSON.parse(text) : null,
  };
}

type Listed = {
  sessions: Array<{ id: string; queueCounts: Record<string, number> }>;
};

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'session-list-queue-counts-secret-at-least-32-chars';
  await migrate();
  await pool.query(
    `TRUNCATE audit_events, staff_sessions, queue_command_receipts,
       queue_registration_receipts, queue_entries, patient_operational_records,
       session_command_receipts, consultation_sessions, schedule_templates,
       clinic_memberships, doctor_clinics, doctor_profiles, clinics, users CASCADE`,
  );
  for (const [key, subject] of Object.entries(subjects))
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $2)`,
      [ids[key as keyof typeof subjects], subject],
    );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'sc-a', 'A'), ($2, 'sc-b', 'B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'receptionist'), ($1, $4, 'doctor'), ($1, $5, 'doctor'),
       ($2, $6, 'clinic_admin')`,
    [
      ids.clinicA,
      ids.clinicB,
      ids.receptionistA,
      ids.doctorA,
      ids.doctorA2,
      ids.adminB,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $3, 'Dr A'), ($2, $4, 'Dr A2')`,
    [ids.profileA, ids.profileA2, ids.doctorA, ids.doctorA2],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2), ($1, $3)`,
    [ids.clinicA, ids.profileA, ids.profileA2],
  );
  await pool.query(
    `INSERT INTO consultation_sessions (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES ($1, $3, $4, CURRENT_DATE, CURRENT_DATE + time '09:00', CURRENT_DATE + time '12:00', 'open'),
            ($2, $3, $5, CURRENT_DATE, CURRENT_DATE + time '13:00', CURRENT_DATE + time '16:00', 'open')`,
    [ids.session, ids.sessionA2, ids.clinicA, ids.profileA, ids.profileA2],
  );
  today = (await pool.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`))
    .rows[0]!.d;

  const queue = new QueueService(pool);
  const reception = { clinicId: ids.clinicA, actorUserId: ids.receptionistA };
  const e: string[] = [];
  for (let i = 0; i < 5; i++) {
    const item = await queue.registerWalkIn(reception, ids.session, {
      privateDisplayName: `Secret Patient ${i}`,
      preferredLocale: 'fr',
      idempotencyKey: `sc-seed-${i}`,
      correlationId: `sc-seed-${i}`,
    });
    e.push(item.entry.id);
  }
  let n = 0;
  const run = (entryId: string, command: string, extra = {}) =>
    queue.command(reception, ids.session, entryId, {
      command: command as never,
      idempotencyKey: `sc-cmd-${++n}`,
      correlationId: `sc-cmd-${n}`,
      ...extra,
    });
  // e3 completed; e2 called; e1 checked in; e4 cancelled; e0 still waiting.
  await run(e[3]!, 'check_in');
  await run(e[3]!, 'call');
  await run(e[3]!, 'start_consultation');
  await run(e[3]!, 'complete_consultation');
  await run(e[2]!, 'check_in');
  await run(e[2]!, 'call');
  await run(e[1]!, 'check_in');
  await run(e[4]!, 'check_in');
  await run(e[4]!, 'cancel', {
    reason: 'duplicate registration',
    cancellationSource: 'clinic',
  });
  await queue.registerWalkIn(reception, ids.sessionA2, {
    privateDisplayName: 'Secret Other Patient',
    preferredLocale: 'ar',
    idempotencyKey: 'sc-seed-other',
    correlationId: 'sc-seed-other',
  });
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('staff session list queue counts (G-17)', () => {
  it('reception sees aggregate counts by state for every session of the day', async () => {
    const res = await get(subjects.receptionistA, today);
    expect(res.status).toBe(200);
    const sessions = (res.body as Listed).sessions;
    expect(sessions.map((s) => s.id).sort()).toEqual(
      [ids.session, ids.sessionA2].sort(),
    );
    expect(sessions.find((s) => s.id === ids.session)!.queueCounts).toEqual({
      waiting: 1,
      checkedIn: 1,
      called: 1,
      inConsultation: 0,
      completed: 1,
      noShow: 0,
      cancelled: 1,
    });
    expect(sessions.find((s) => s.id === ids.sessionA2)!.queueCounts).toEqual({
      waiting: 1,
      checkedIn: 0,
      called: 0,
      inConsultation: 0,
      completed: 0,
      noShow: 0,
      cancelled: 0,
    });
    // Counts only: no patient names or public labels in the session list.
    expect(res.text).not.toContain('Secret');
    expect(res.text).not.toMatch(/"publicDisplayLabel"|"privateDisplayName"/);
  });

  it('a doctor sees counts only for their own session', async () => {
    const res = await get(subjects.doctorA, today);
    expect(res.status).toBe(200);
    const sessions = (res.body as Listed).sessions;
    expect(sessions.map((s) => s.id)).toEqual([ids.session]);
    expect(sessions[0]!.queueCounts.completed).toBe(1);
  });

  it('another clinic is denied and a day without sessions is empty', async () => {
    expect((await get(subjects.adminB, today)).status).toBe(403);
    const empty = await get(subjects.receptionistA, '2001-01-01');
    expect(empty.status).toBe(200);
    expect((empty.body as Listed).sessions).toEqual([]);
  });
});
