import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';
import { POST as addAbsence } from '@/app/api/clinics/[clinicId]/doctors/[doctorId]/absences/route';
import { DELETE as removeAbsence } from '@/app/api/clinics/[clinicId]/doctors/[doctorId]/absences/[absenceDate]/route';

// TAB-P0-01 (#769), doctor-absence family: service-level role checks with VALID
// payloads against a seeded clinic-A doctor. The generic matrix (#767) sends
// `{}` bodies and random ids, so a 400/404 could mask a missing role check.
// The same valid request must succeed for the clinic-A admin (and the doctor
// themself) and be 403 for a clinic-B admin, a clinic-A receptionist and a
// different clinic-A doctor, with no mutation.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ORIGIN = 'http://localhost';
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  adminA: randomUUID(),
  adminB: randomUUID(),
  receptionistA: randomUUID(),
  doctorUserA: randomUUID(),
  otherDoctorUserA: randomUUID(),
  doctorA: randomUUID(),
  otherDoctorA: randomUUID(),
};
const subjects = {
  adminA: 'da-admin-a',
  adminB: 'da-admin-b',
  receptionistA: 'da-reception-a',
  doctorUserA: 'da-doctor-a',
  otherDoctorUserA: 'da-other-doctor-a',
};
const NEW_DAY = '2027-03-01';
const SEEDED_DAY = '2027-03-02';
const DOCTOR_DAY = '2027-03-03';

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

async function add(cookie: string, day: string) {
  const res = await addAbsence(
    request(
      `${ORIGIN}/api/clinics/${ids.clinicA}/doctors/${ids.doctorA}/absences`,
      'POST',
      cookie,
      { absenceDate: day },
    ),
    {
      params: Promise.resolve({
        clinicId: ids.clinicA,
        doctorId: ids.doctorA,
      }),
    },
  );
  return res.status;
}

async function remove(cookie: string, day: string) {
  const res = await removeAbsence(
    request(
      `${ORIGIN}/api/clinics/${ids.clinicA}/doctors/${ids.doctorA}/absences/${day}`,
      'DELETE',
      cookie,
      undefined,
    ),
    {
      params: Promise.resolve({
        clinicId: ids.clinicA,
        doctorId: ids.doctorA,
        absenceDate: day,
      }),
    },
  );
  return res.status;
}

async function absenceCount(day: string): Promise<number> {
  const r = await pool.query(
    `SELECT 1 FROM doctor_absences
      WHERE clinic_id = $1 AND doctor_id = $2 AND absence_date = $3::date`,
    [ids.clinicA, ids.doctorA, day],
  );
  return r.rowCount ?? 0;
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'cross-tenant-absences-secret-at-least-32-chars-long';
  await migrate();
  await pool.query(
    `TRUNCATE audit_events, staff_sessions, doctor_absences, doctor_clinics,
       doctor_profiles, clinic_memberships, clinics, users CASCADE`,
  );
  for (const [key, subject] of Object.entries(subjects)) {
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $2)`,
      [ids[key as keyof typeof subjects], subject],
    );
  }
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'da-a', 'A'), ($2, 'da-b', 'B')`,
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
      ids.doctorUserA,
      ids.otherDoctorUserA,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
       ($1, $2, 'Doctor A'), ($3, $4, 'Other Doctor A')`,
    [ids.doctorA, ids.doctorUserA, ids.otherDoctorA, ids.otherDoctorUserA],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2), ($1, $3)`,
    [ids.clinicA, ids.doctorA, ids.otherDoctorA],
  );
  await pool.query(
    `INSERT INTO doctor_absences (clinic_id, doctor_id, absence_date)
     VALUES ($1, $2, $3::date)`,
    [ids.clinicA, ids.doctorA, SEEDED_DAY],
  );
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

const denied: Array<keyof typeof subjects> = [
  'adminB',
  'receptionistA',
  'otherDoctorUserA',
];

describe('doctor absence mutations enforce clinic_admin or the doctor themself', () => {
  it.each(denied)('POST is 403 for %s, creating nothing', async (who) => {
    expect(await add(await cookieFor(subjects[who]), NEW_DAY)).toBe(403);
    expect(await absenceCount(NEW_DAY)).toBe(0);
  });

  it.each(denied)('DELETE is 403 for %s, keeping the absence', async (who) => {
    expect(await remove(await cookieFor(subjects[who]), SEEDED_DAY)).toBe(403);
    expect(await absenceCount(SEEDED_DAY)).toBe(1);
  });

  it('POST succeeds for the clinic-A admin with a valid payload', async () => {
    expect(await add(await cookieFor(subjects.adminA), NEW_DAY)).toBe(201);
    expect(await absenceCount(NEW_DAY)).toBe(1);
  });

  it('POST succeeds for the doctor themself', async () => {
    expect(await add(await cookieFor(subjects.doctorUserA), DOCTOR_DAY)).toBe(
      201,
    );
    expect(await absenceCount(DOCTOR_DAY)).toBe(1);
  });

  it('DELETE succeeds for the doctor themself and removes the absence', async () => {
    expect(await absenceCount(DOCTOR_DAY)).toBe(1);
    expect(
      await remove(await cookieFor(subjects.doctorUserA), DOCTOR_DAY),
    ).toBe(200);
    expect(await absenceCount(DOCTOR_DAY)).toBe(0);
  });

  it('DELETE succeeds for the clinic-A admin and removes the absence', async () => {
    expect(await remove(await cookieFor(subjects.adminA), SEEDED_DAY)).toBe(
      200,
    );
    expect(await absenceCount(SEEDED_DAY)).toBe(0);
  });
});
