import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';
import { POST as createType } from '@/app/api/clinics/[clinicId]/consultation-types/route';
import { PATCH as setActive } from '@/app/api/clinics/[clinicId]/consultation-types/[consultationTypeId]/route';

// TAB-P0-01 (#769): service-level role checks with VALID payloads against
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
  seededType: randomUUID(),
};
const subjects = {
  adminA: 'ct-admin-a',
  adminB: 'ct-admin-b',
  receptionistA: 'ct-reception-a',
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

const validCreate = {
  code: 'follow-up',
  label: 'Follow-up',
  nominalDurationMinutes: 20,
};

async function create(cookie: string, code = validCreate.code) {
  const res = await createType(
    request(
      `${ORIGIN}/api/clinics/${ids.clinicA}/consultation-types`,
      'POST',
      cookie,
      { ...validCreate, code },
    ),
    { params: Promise.resolve({ clinicId: ids.clinicA }) },
  );
  return res.status;
}

async function patch(cookie: string, active: boolean) {
  const res = await setActive(
    request(
      `${ORIGIN}/api/clinics/${ids.clinicA}/consultation-types/${ids.seededType}`,
      'PATCH',
      cookie,
      { active },
    ),
    {
      params: Promise.resolve({
        clinicId: ids.clinicA,
        consultationTypeId: ids.seededType,
      }),
    },
  );
  return res.status;
}

async function seededActive(): Promise<boolean> {
  const r = await pool.query<{ active: boolean }>(
    `SELECT active FROM consultation_types WHERE id = $1`,
    [ids.seededType],
  );
  return r.rows[0].active;
}

async function typeCount(code: string): Promise<number> {
  const r = await pool.query(
    `SELECT 1 FROM consultation_types WHERE clinic_id = $1 AND code = $2`,
    [ids.clinicA, code],
  );
  return r.rowCount ?? 0;
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'cross-tenant-consultation-types-secret-at-least-32-chars';
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
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'ct-a', 'A'), ($2, 'ct-b', 'B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($2, $4, 'clinic_admin'), ($1, $5, 'receptionist')`,
    [ids.clinicA, ids.clinicB, ids.adminA, ids.adminB, ids.receptionistA],
  );
  await pool.query(
    `INSERT INTO consultation_types (id, clinic_id, code, label, nominal_duration_minutes)
     VALUES ($1, $2, 'seeded', 'Seeded', 15)`,
    [ids.seededType, ids.clinicA],
  );
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('consultation-type mutations enforce clinic_admin of the target clinic', () => {
  it('POST succeeds for the clinic-A admin with a valid payload', async () => {
    expect(await create(await cookieFor(subjects.adminA), 'ok-admin-a')).toBe(
      201,
    );
    expect(await typeCount('ok-admin-a')).toBe(1);
  });

  it('POST is 403 for a clinic-B admin and a clinic-A receptionist, creating nothing', async () => {
    expect(await create(await cookieFor(subjects.adminB), 'deny-b')).toBe(403);
    expect(
      await create(await cookieFor(subjects.receptionistA), 'deny-recep'),
    ).toBe(403);
    expect(await typeCount('deny-b')).toBe(0);
    expect(await typeCount('deny-recep')).toBe(0);
  });

  it('PATCH is 403 for a clinic-B admin and a clinic-A receptionist, leaving the type unchanged', async () => {
    expect(await patch(await cookieFor(subjects.adminB), false)).toBe(403);
    expect(await patch(await cookieFor(subjects.receptionistA), false)).toBe(
      403,
    );
    expect(await seededActive()).toBe(true);
  });

  it('PATCH succeeds for the clinic-A admin and mutates the type', async () => {
    expect(await patch(await cookieFor(subjects.adminA), false)).toBe(200);
    expect(await seededActive()).toBe(false);
  });
});
