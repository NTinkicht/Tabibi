import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import * as doctors from '@/app/api/clinics/[clinicId]/doctors/route';
import * as memberItem from '@/app/api/clinics/[clinicId]/memberships/[userId]/route';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

// TAB-P0-02 (#667): POST /api/clinics/{clinicId}/doctors associates an
// existing member of this clinic as a doctor. It never adds a member, never
// renames a doctor profile shared with another clinic, never demotes the last
// clinic_admin and never lets the caller choose the profile id.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  otherAdmin: randomUUID(),
  receptionist: randomUUID(),
  sharedDoctorUser: randomUUID(),
  sharedDoctor: randomUUID(),
  outsider: randomUUID(),
};
const ORIGIN = 'http://localhost';

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'doctor-association-http-api-test-secret-at-least-32-chars';
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, staff_sessions, doctor_clinics,
    doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'da-admin', 'Admin'), ($2, 'da-other-admin', 'Other Admin'),
       ($3, 'da-receptionist', 'Receptionist'),
       ($4, 'da-shared-doctor', 'Shared Doctor'), ($5, 'da-outsider', 'Outsider')`,
    [
      ids.admin,
      ids.otherAdmin,
      ids.receptionist,
      ids.sharedDoctorUser,
      ids.outsider,
    ],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'da-clinic', 'Clinic'), ($2, 'da-other-clinic', 'Other')`,
    [ids.clinic, ids.otherClinic],
  );
  // The shared doctor already works at the other clinic and is a
  // receptionist member here.
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name)
     VALUES ($1, $2, 'Dr Yacine')`,
    [ids.sharedDoctor, ids.sharedDoctorUser],
  );
  await pool.query(
    'INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)',
    [ids.otherClinic, ids.sharedDoctor],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($1, $4, 'receptionist'),
       ($1, $5, 'receptionist'),
       ($2, $6, 'clinic_admin'), ($2, $5, 'doctor'), ($2, $7, 'receptionist')`,
    [
      ids.clinic,
      ids.otherClinic,
      ids.admin,
      ids.receptionist,
      ids.sharedDoctorUser,
      ids.otherAdmin,
      ids.outsider,
    ],
  );
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

async function cookieFor(subject: string): Promise<string> {
  return `tabibi_staff_session=${await createStaffSessionToken(
    subject,
    new Date(Date.now() + 60_000),
  )}`;
}

async function addDoctor(
  subject: string,
  body: unknown,
  clinicId = ids.clinic,
): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
  const res = await doctors.POST(
    new Request(`${ORIGIN}/api/clinics/${clinicId}/doctors`, {
      method: 'POST',
      headers: {
        cookie: await cookieFor(subject),
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ clinicId }) },
  );
  return { status: res.status, json: await res.json(), res };
}

async function listDoctors(subject: string, clinicId = ids.clinic) {
  const res = await doctors.GET(
    new Request(`${ORIGIN}/api/clinics/${clinicId}/doctors`, {
      headers: { cookie: await cookieFor(subject) },
    }),
    { params: Promise.resolve({ clinicId }) },
  );
  return { status: res.status, json: await res.json() };
}

async function setRole(subject: string, userId: string, role: string) {
  const res = await memberItem.PATCH(
    new Request(`${ORIGIN}/api/clinics/${ids.clinic}/memberships/${userId}`, {
      method: 'PATCH',
      headers: {
        cookie: await cookieFor(subject),
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role }),
    }),
    { params: Promise.resolve({ clinicId: ids.clinic, userId }) },
  );
  return res.status;
}

async function snapshot() {
  const [profiles, associations, memberships, audits] = await Promise.all([
    pool.query(
      'SELECT id, user_id, display_name FROM doctor_profiles ORDER BY id',
    ),
    pool.query(
      'SELECT clinic_id, doctor_id FROM doctor_clinics ORDER BY clinic_id, doctor_id',
    ),
    pool.query(
      `SELECT clinic_id, user_id, role FROM clinic_memberships
        ORDER BY clinic_id, user_id`,
    ),
    pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE action = 'doctor.associated'`,
    ),
  ]);
  return {
    profiles: profiles.rows,
    associations: associations.rows,
    memberships: memberships.rows,
    audits: audits.rows[0].n as number,
  };
}

describe('doctor association HTTP API (#667)', () => {
  it('associates an existing member as a doctor with one audit event', async () => {
    const added = await addDoctor('da-admin', {
      userId: ids.receptionist,
      displayName: '  Dr Amina  ',
    });
    expect(added.status).toBe(201);
    expect(added.res.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(added.json)).toEqual(['doctor']);
    const doctor = added.json.doctor as Record<string, unknown>;
    expect(Object.keys(doctor).sort()).toEqual([
      'displayName',
      'id',
      'specialtyCodes',
      'userId',
    ]);
    expect(doctor).toMatchObject({
      userId: ids.receptionist,
      displayName: 'Dr Amina',
      specialtyCodes: [],
    });
    const state = await snapshot();
    expect(state.audits).toBe(1);
    expect(state.associations).toContainEqual({
      clinic_id: ids.clinic,
      doctor_id: doctor.id,
    });
    expect(state.memberships).toContainEqual({
      clinic_id: ids.clinic,
      user_id: ids.receptionist,
      role: 'doctor',
    });
    expect((await listDoctors('da-admin')).json).toEqual({
      doctors: [doctor],
    });
    // The membership role rule now accepts the doctor role again.
    expect(await setRole('da-admin', ids.receptionist, 'receptionist')).toBe(
      200,
    );
    expect(await setRole('da-admin', ids.receptionist, 'doctor')).toBe(200);
  });

  it('is a no-op without audit when already associated as a doctor', async () => {
    const body = { userId: ids.receptionist, displayName: 'Dr Amina' };
    expect((await addDoctor('da-admin', body)).status).toBe(201);
    const before = await snapshot();
    const again = await addDoctor('da-admin', {
      ...body,
      displayName: 'Renamed',
    });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ doctor: { displayName: 'Dr Amina' } });
    expect(await snapshot()).toEqual(before);
  });

  it('keeps the display name of a doctor profile shared with another clinic', async () => {
    const added = await addDoctor('da-admin', {
      userId: ids.sharedDoctorUser,
      displayName: 'Hijacked Name',
    });
    expect(added.status).toBe(201);
    expect(added.json).toEqual({
      doctor: {
        id: ids.sharedDoctor,
        userId: ids.sharedDoctorUser,
        displayName: 'Dr Yacine',
        specialtyCodes: [],
      },
    });
    const state = await snapshot();
    expect(state.profiles).toEqual([
      {
        id: ids.sharedDoctor,
        user_id: ids.sharedDoctorUser,
        display_name: 'Dr Yacine',
      },
    ]);
    expect((await listDoctors('da-other-admin', ids.otherClinic)).json).toEqual(
      {
        doctors: [
          {
            id: ids.sharedDoctor,
            userId: ids.sharedDoctorUser,
            displayName: 'Dr Yacine',
            specialtyCodes: [],
          },
        ],
      },
    );
  });

  it('never adds a member: non-member, unknown and other-clinic users are the same 404', async () => {
    const before = await snapshot();
    for (const userId of [ids.outsider, ids.otherAdmin, randomUUID()]) {
      const response = await addDoctor('da-admin', {
        userId,
        displayName: 'Dr X',
      });
      expect(response.status).toBe(404);
      expect(response.json).toMatchObject({
        error: 'not_found',
        message: 'Membership not found',
      });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to turn the last clinic admin into a doctor', async () => {
    const before = await snapshot();
    const response = await addDoctor('da-admin', {
      userId: ids.admin,
      displayName: 'Dr Admin',
    });
    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({ error: 'conflict' });
    expect(await snapshot()).toEqual(before);
  });

  it('denies non-admin staff and other clinics', async () => {
    const body = { userId: ids.receptionist, displayName: 'Dr Amina' };
    expect((await addDoctor('da-admin', body)).status).toBe(201);
    const before = await snapshot();
    for (const subject of ['da-receptionist', 'da-shared-doctor']) {
      const response = await addDoctor(subject, {
        userId: ids.sharedDoctorUser,
        displayName: 'Dr Y',
      });
      expect(response.status).toBe(403);
      expect(response.json).toMatchObject({ error: 'forbidden' });
    }
    expect(
      (
        await addDoctor('da-other-admin', {
          userId: ids.sharedDoctorUser,
          displayName: 'Dr Y',
        })
      ).status,
    ).toBe(403);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects invalid bodies with 400 and writes nothing', async () => {
    const before = await snapshot();
    for (const body of [
      {
        userId: ids.receptionist,
        displayName: 'Dr Amina',
        doctorId: randomUUID(),
      },
      { userId: ids.receptionist, displayName: '   ' },
      { userId: ids.receptionist, displayName: 'x'.repeat(121) },
      { userId: ids.receptionist, displayName: 'Dr\u0000Amina' },
      { userId: ids.receptionist, displayName: 'Dr\nAmina' },
      { userId: 'nope', displayName: 'Dr Amina' },
      { userId: ids.receptionist },
      { displayName: 'Dr Amina' },
      'not json',
    ]) {
      const response = await addDoctor('da-admin', body);
      expect(response.status).toBe(400);
      expect(response.json).toMatchObject({ error: 'invalid_request' });
    }
    expect(await snapshot()).toEqual(before);
  });
});
