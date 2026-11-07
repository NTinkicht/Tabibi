import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';
import {
  GET as listDoctors,
  POST as addDoctor,
} from '@/app/api/clinics/[clinicId]/doctors/route';
import { PATCH as setSpecialties } from '@/app/api/clinics/[clinicId]/doctors/[doctorId]/route';

// TAB-P0-01 (#769), doctor-roster family: service-level role checks with VALID
// payloads against seeded clinic-A resources. The generic matrix (#767) sends
// `{}` bodies and random ids, so a 400/404 could mask a missing
// requireClinicRole. Add-doctor and set-specialties are clinic_admin only;
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
  candidateA: randomUUID(),
  doctorProfileA: randomUUID(),
};
const subjects = {
  adminA: 'dr-admin-a',
  adminB: 'dr-admin-b',
  receptionistA: 'dr-reception-a',
  doctorA: 'dr-doctor-a',
  candidateA: 'dr-candidate-a',
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
const base = () => `${ORIGIN}/api/clinics/${ids.clinicA}/doctors`;

async function list(cookie: string) {
  return (await listDoctors(request(base(), 'GET', cookie), clinicCtx)).status;
}

async function add(cookie: string) {
  const res = await addDoctor(
    request(base(), 'POST', cookie, {
      userId: ids.candidateA,
      displayName: 'Dr Candidate',
    }),
    clinicCtx,
  );
  return res.status;
}

async function specialties(cookie: string) {
  const res = await setSpecialties(
    request(`${base()}/${ids.doctorProfileA}`, 'PATCH', cookie, {
      specialtyCodes: ['pediatrics'],
    }),
    {
      params: Promise.resolve({
        clinicId: ids.clinicA,
        doctorId: ids.doctorProfileA,
      }),
    },
  );
  return res.status;
}

async function candidateState() {
  const role = await pool.query<{ role: string }>(
    `SELECT role FROM clinic_memberships WHERE clinic_id = $1 AND user_id = $2`,
    [ids.clinicA, ids.candidateA],
  );
  const profile = await pool.query(
    `SELECT 1 FROM doctor_profiles WHERE user_id = $1`,
    [ids.candidateA],
  );
  return { role: role.rows[0]?.role, profiles: profile.rowCount ?? 0 };
}

async function seededCodes(): Promise<string[]> {
  const r = await pool.query<{ specialty_codes: string[] }>(
    `SELECT specialty_codes FROM doctor_clinics WHERE clinic_id = $1 AND doctor_id = $2`,
    [ids.clinicA, ids.doctorProfileA],
  );
  return r.rows[0]!.specialty_codes;
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'cross-tenant-doctors-secret-at-least-32-chars-long';
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
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'dr-a', 'A'), ($2, 'dr-b', 'B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($2, $4, 'clinic_admin'), ($1, $5, 'receptionist'),
       ($1, $6, 'doctor'), ($1, $7, 'receptionist')`,
    [
      ids.clinicA,
      ids.clinicB,
      ids.adminA,
      ids.adminB,
      ids.receptionistA,
      ids.doctorA,
      ids.candidateA,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Dr A')`,
    [ids.doctorProfileA, ids.doctorA],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
    [ids.clinicA, ids.doctorProfileA],
  );
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('doctor roster routes enforce the target clinic role', () => {
  it('POST add-doctor is 403 for a clinic-B admin, receptionist and doctor of clinic A, changing nothing', async () => {
    expect(await add(await cookieFor(subjects.adminB))).toBe(403);
    expect(await add(await cookieFor(subjects.receptionistA))).toBe(403);
    expect(await add(await cookieFor(subjects.doctorA))).toBe(403);
    expect(await candidateState()).toEqual({
      role: 'receptionist',
      profiles: 0,
    });
  });

  it('PATCH specialties is 403 for a clinic-B admin, receptionist and the doctor themself, changing nothing', async () => {
    expect(await specialties(await cookieFor(subjects.adminB))).toBe(403);
    expect(await specialties(await cookieFor(subjects.receptionistA))).toBe(
      403,
    );
    expect(await specialties(await cookieFor(subjects.doctorA))).toBe(403);
    expect(await seededCodes()).toEqual([]);
  });

  it('GET list is 403 for a clinic-B admin but allowed for clinic-A staff roles', async () => {
    expect(await list(await cookieFor(subjects.adminB))).toBe(403);
    expect(await list(await cookieFor(subjects.receptionistA))).toBe(200);
    expect(await list(await cookieFor(subjects.doctorA))).toBe(200);
  });

  it('POST add-doctor succeeds for the clinic-A admin with a valid payload', async () => {
    expect(await add(await cookieFor(subjects.adminA))).toBe(201);
    expect(await candidateState()).toEqual({ role: 'doctor', profiles: 1 });
  });

  it('PATCH specialties succeeds for the clinic-A admin and stores the codes', async () => {
    expect(await specialties(await cookieFor(subjects.adminA))).toBe(200);
    expect(await seededCodes()).toEqual(['pediatrics']);
  });
});
