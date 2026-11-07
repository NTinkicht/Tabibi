import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';
import {
  GET as listTemplates,
  POST as createTemplate,
} from '@/app/api/clinics/[clinicId]/schedule-templates/route';
import { PATCH as setActive } from '@/app/api/clinics/[clinicId]/schedule-templates/[templateId]/route';
import { POST as generate } from '@/app/api/clinics/[clinicId]/schedule-generations/route';

// TAB-P0-01 (#776, #769 follow-up), schedule-template/generation family:
// service-level role checks with VALID payloads against seeded clinic-A
// resources. The generic matrix (#767) sends `{}` bodies, so a 400/404 could
// mask a missing requireClinicRole/requireScheduleWrite. Writes are allowed to
// the clinic_admin and to a doctor acting on their own schedule only;
// listing is open to doctor/receptionist/clinic_admin of the target clinic.
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
  template: randomUUID(),
};
const subjects = {
  adminA: 'st-admin-a',
  adminB: 'st-admin-b',
  receptionistA: 'st-reception-a',
  doctorA: 'st-doctor-a',
  doctorA2: 'st-doctor-a2',
};

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
      cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const clinicCtx = { params: Promise.resolve({ clinicId: ids.clinicA }) };
const root = () => `${ORIGIN}/api/clinics/${ids.clinicA}`;

async function list(cookie: string) {
  const url = `${root()}/schedule-templates?doctorId=${ids.profileA}`;
  return (await listTemplates(request(url, 'GET', cookie), clinicCtx)).status;
}

async function create(cookie: string, doctorId = ids.profileA) {
  const res = await createTemplate(
    request(`${root()}/schedule-templates`, 'POST', cookie, {
      doctorId,
      weekday: 2,
      localStartTime: '13:00',
      localEndTime: '16:00',
      occurrenceIndex: 1,
    }),
    clinicCtx,
  );
  return res.status;
}

async function toggle(cookie: string, active: boolean) {
  const res = await setActive(
    request(`${root()}/schedule-templates/${ids.template}`, 'PATCH', cookie, {
      active,
    }),
    {
      params: Promise.resolve({
        clinicId: ids.clinicA,
        templateId: ids.template,
      }),
    },
  );
  return res.status;
}

async function generateFor(cookie: string, doctorId = ids.profileA) {
  const res = await generate(
    request(`${root()}/schedule-generations`, 'POST', cookie, {
      doctorId,
      startDate: '2027-03-01',
      daysAhead: 7,
    }),
    clinicCtx,
  );
  return res.status;
}

async function templateCount(): Promise<number> {
  const r = await pool.query(
    `SELECT 1 FROM schedule_templates WHERE clinic_id = $1`,
    [ids.clinicA],
  );
  return r.rowCount ?? 0;
}

async function templateActive(): Promise<boolean> {
  const r = await pool.query<{ active: boolean }>(
    `SELECT active FROM schedule_templates WHERE id = $1`,
    [ids.template],
  );
  return r.rows[0]!.active;
}

async function sessionCount(): Promise<number> {
  const r = await pool.query(
    `SELECT 1 FROM consultation_sessions WHERE clinic_id = $1`,
    [ids.clinicA],
  );
  return r.rowCount ?? 0;
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'cross-tenant-templates-secret-at-least-32-chars-long';
  await migrate();
  await pool.query(
    `TRUNCATE audit_events, staff_sessions, clinic_memberships, doctor_clinics, doctor_profiles, clinics, users CASCADE`,
  );
  for (const [key, subject] of Object.entries(subjects)) {
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $2)`,
      [ids[key as keyof typeof subjects], subject],
    );
  }
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'st-a', 'A'), ($2, 'st-b', 'B')`,
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
    `INSERT INTO schedule_templates
       (id, clinic_id, doctor_id, weekday, local_start_time, local_end_time, occurrence_index, active)
     VALUES ($1, $2, $3, 1, '09:00', '12:00', 0, true)`,
    [ids.template, ids.clinicA, ids.profileA],
  );
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('schedule template and generation routes enforce the target clinic role', () => {
  it('POST template is 403 for a clinic-B admin, receptionist and another doctor, changing nothing', async () => {
    expect(await create(await cookieFor(subjects.adminB))).toBe(403);
    expect(await create(await cookieFor(subjects.receptionistA))).toBe(403);
    expect(await create(await cookieFor(subjects.doctorA2))).toBe(403);
    expect(await templateCount()).toBe(1);
  });

  it('PATCH active is 403 for a clinic-B admin, receptionist and another doctor, changing nothing', async () => {
    expect(await toggle(await cookieFor(subjects.adminB), false)).toBe(403);
    expect(await toggle(await cookieFor(subjects.receptionistA), false)).toBe(
      403,
    );
    expect(await toggle(await cookieFor(subjects.doctorA2), false)).toBe(403);
    expect(await templateActive()).toBe(true);
  });

  it('POST generation is 403 for a clinic-B admin, receptionist and another doctor, planning nothing', async () => {
    expect(await generateFor(await cookieFor(subjects.adminB))).toBe(403);
    expect(await generateFor(await cookieFor(subjects.receptionistA))).toBe(
      403,
    );
    expect(await generateFor(await cookieFor(subjects.doctorA2))).toBe(403);
    expect(await sessionCount()).toBe(0);
  });

  it('GET list is 403 for a clinic-B admin but allowed for clinic-A staff roles', async () => {
    expect(await list(await cookieFor(subjects.adminB))).toBe(403);
    expect(await list(await cookieFor(subjects.receptionistA))).toBe(200);
    expect(await list(await cookieFor(subjects.doctorA2))).toBe(200);
    expect(await list(await cookieFor(subjects.adminA))).toBe(200);
  });

  it('the clinic-A admin and the owning doctor succeed with valid payloads', async () => {
    expect(await create(await cookieFor(subjects.adminA))).toBe(201);
    expect(await templateCount()).toBe(2);
    expect(await toggle(await cookieFor(subjects.doctorA), false)).toBe(200);
    expect(await templateActive()).toBe(false);
    expect(await toggle(await cookieFor(subjects.adminA), true)).toBe(200);
    expect(await templateActive()).toBe(true);
    expect(await generateFor(await cookieFor(subjects.adminA))).toBe(200);
    expect(await sessionCount()).toBeGreaterThan(0);
  });
});
