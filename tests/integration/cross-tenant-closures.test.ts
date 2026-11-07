import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';
import { POST as addClosure } from '@/app/api/clinics/[clinicId]/closures/route';
import { DELETE as removeClosure } from '@/app/api/clinics/[clinicId]/closures/[closureDate]/route';

// TAB-P0-01 (#769), closures family: service-level role checks with VALID payloads against
// seeded clinic-A resources. The generic matrix (#767) sends `{}` bodies and
// random ids, so a 400/404 could mask a missing requireClinicRole. Here the
// same valid request must succeed for a clinic-A admin and be denied (403)
// for a clinic-B admin and for a clinic-A receptionist, with no mutation.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ORIGIN = 'http://localhost';
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  adminA: randomUUID(),
  adminB: randomUUID(),
  receptionistA: randomUUID(),
};
const subjects = {
  adminA: 'cl-admin-a',
  adminB: 'cl-admin-b',
  receptionistA: 'cl-reception-a',
};

async function cookieFor(subject: string): Promise<string> {
  const token = await createStaffSessionToken(
    subject,
    new Date(Date.now() + 60_000),
  );
  return `tabibi_staff_session=${token}`;
}

function request(url: string, method: string, cookie: string, body: unknown) {
  return new Request(url, {
    method,
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify(body),
  });
}

const NEW_DAY = '2027-03-01';
const SEEDED_DAY = '2027-03-02';

async function add(cookie: string, day = NEW_DAY) {
  const res = await addClosure(
    request(`${ORIGIN}/api/clinics/${ids.clinicA}/closures`, 'POST', cookie, {
      closureDate: day,
    }),
    { params: Promise.resolve({ clinicId: ids.clinicA }) },
  );
  return res.status;
}

async function remove(cookie: string, day = SEEDED_DAY) {
  const res = await removeClosure(
    request(
      `${ORIGIN}/api/clinics/${ids.clinicA}/closures/${day}`,
      'DELETE',
      cookie,
      undefined,
    ),
    {
      params: Promise.resolve({ clinicId: ids.clinicA, closureDate: day }),
    },
  );
  return res.status;
}

async function closureCount(day: string): Promise<number> {
  const r = await pool.query(
    `SELECT 1 FROM clinic_closures WHERE clinic_id = $1 AND closure_date = $2::date`,
    [ids.clinicA, day],
  );
  return r.rowCount ?? 0;
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'cross-tenant-closures-secret-at-least-32-chars-long';
  await migrate();
  await pool.query(
    `TRUNCATE audit_events, staff_sessions, clinic_memberships, clinics, users CASCADE`,
  );
  for (const [key, subject] of Object.entries(subjects)) {
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $2)`,
      [ids[key as keyof typeof subjects], subject],
    );
  }
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'cl-a', 'A'), ($2, 'cl-b', 'B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($2, $4, 'clinic_admin'), ($1, $5, 'receptionist')`,
    [ids.clinicA, ids.clinicB, ids.adminA, ids.adminB, ids.receptionistA],
  );
  await pool.query(
    `INSERT INTO clinic_closures (clinic_id, closure_date) VALUES ($1, $2::date)`,
    [ids.clinicA, SEEDED_DAY],
  );
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('closure mutations enforce clinic_admin of the target clinic', () => {
  it('POST is 403 for a clinic-B admin and a clinic-A receptionist, creating nothing', async () => {
    expect(await add(await cookieFor(subjects.adminB))).toBe(403);
    expect(await add(await cookieFor(subjects.receptionistA))).toBe(403);
    expect(await closureCount(NEW_DAY)).toBe(0);
  });

  it('DELETE is 403 for a clinic-B admin and a clinic-A receptionist, keeping the closure', async () => {
    expect(await remove(await cookieFor(subjects.adminB))).toBe(403);
    expect(await remove(await cookieFor(subjects.receptionistA))).toBe(403);
    expect(await closureCount(SEEDED_DAY)).toBe(1);
  });

  it('POST succeeds for the clinic-A admin with a valid payload', async () => {
    expect(await add(await cookieFor(subjects.adminA))).toBe(201);
    expect(await closureCount(NEW_DAY)).toBe(1);
  });

  it('DELETE succeeds for the clinic-A admin and removes the closure', async () => {
    expect(await remove(await cookieFor(subjects.adminA))).toBe(200);
    expect(await closureCount(SEEDED_DAY)).toBe(0);
  });
});
