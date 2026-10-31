import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import * as doctors from '@/app/api/clinics/[clinicId]/doctors/route';
import * as doctorItem from '@/app/api/clinics/[clinicId]/doctors/[doctorId]/route';
import { SPECIALTIES } from '@/modules/clinic/specialties';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

// TAB-P0-03 (#687, #669 Q2 = A): PATCH /api/clinics/{clinicId}/doctors/{doctorId}
// sets 1 to 3 controlled specialty codes on this clinic's association with the
// doctor. Only this clinic's clinic_admin; never the shared doctor profile,
// never another clinic's association.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  otherAdmin: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  otherOnlyDoctorUser: randomUUID(),
  otherOnlyDoctor: randomUUID(),
};
const ORIGIN = 'http://localhost';

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'doctor-specialties-http-api-test-secret-at-least-32-chars';
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, staff_sessions, doctor_clinics,
    doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'ds-admin', 'Admin'), ($2, 'ds-other-admin', 'Other Admin'),
       ($3, 'ds-receptionist', 'Receptionist'), ($4, 'ds-doctor', 'Doctor'),
       ($5, 'ds-other-only-doctor', 'Other Only Doctor')`,
    [
      ids.admin,
      ids.otherAdmin,
      ids.receptionist,
      ids.doctorUser,
      ids.otherOnlyDoctorUser,
    ],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'ds-clinic', 'Clinic'), ($2, 'ds-other-clinic', 'Other')`,
    [ids.clinic, ids.otherClinic],
  );
  // The doctor works at both clinics; the other-only doctor only at the other.
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
       ($1, $2, 'Dr Yacine'), ($3, $4, 'Dr Other')`,
    [ids.doctor, ids.doctorUser, ids.otherOnlyDoctor, ids.otherOnlyDoctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES
       ($1, $3), ($2, $3), ($2, $4)`,
    [ids.clinic, ids.otherClinic, ids.doctor, ids.otherOnlyDoctor],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($1, $4, 'receptionist'), ($1, $5, 'doctor'),
       ($2, $6, 'clinic_admin'), ($2, $5, 'doctor'), ($2, $7, 'doctor')`,
    [
      ids.clinic,
      ids.otherClinic,
      ids.admin,
      ids.receptionist,
      ids.doctorUser,
      ids.otherAdmin,
      ids.otherOnlyDoctorUser,
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

async function setSpecialties(
  subject: string,
  body: unknown,
  doctorId: string = ids.doctor,
  clinicId: string = ids.clinic,
): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
  const res = await doctorItem.PATCH(
    new Request(`${ORIGIN}/api/clinics/${clinicId}/doctors/${doctorId}`, {
      method: 'PATCH',
      headers: {
        cookie: await cookieFor(subject),
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ clinicId, doctorId }) },
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

async function snapshot() {
  const [profiles, associations, audits] = await Promise.all([
    pool.query(
      'SELECT id, user_id, display_name, updated_at FROM doctor_profiles ORDER BY id',
    ),
    pool.query(
      `SELECT clinic_id, doctor_id, specialty_codes FROM doctor_clinics
        ORDER BY clinic_id, doctor_id`,
    ),
    pool.query(
      `SELECT clinic_id, entity_id, metadata FROM audit_events
        WHERE action = 'doctor.specialties_set' ORDER BY id`,
    ),
  ]);
  return {
    profiles: profiles.rows,
    associations: associations.rows,
    audits: audits.rows,
  };
}

async function codesAt(clinicId: string, doctorId: string) {
  const result = await pool.query<{ specialty_codes: string[] }>(
    `SELECT specialty_codes FROM doctor_clinics
      WHERE clinic_id = $1 AND doctor_id = $2`,
    [clinicId, doctorId],
  );
  return result.rows[0]!.specialty_codes;
}

describe('doctor specialties HTTP API (#687)', () => {
  it('sets and replaces the codes on this clinic association only, with one audit event each', async () => {
    const profilesBefore = (await snapshot()).profiles;
    const set = await setSpecialties('ds-admin', {
      specialtyCodes: ['pediatrics', 'general_medicine'],
    });
    expect(set.status).toBe(200);
    expect(set.res.headers.get('cache-control')).toBe('no-store');
    expect(set.json).toEqual({
      doctor: {
        id: ids.doctor,
        userId: ids.doctorUser,
        displayName: 'Dr Yacine',
        specialtyCodes: ['pediatrics', 'general_medicine'],
      },
    });
    expect((await listDoctors('ds-receptionist')).json).toEqual({
      doctors: [set.json.doctor],
    });

    const replaced = await setSpecialties('ds-admin', {
      specialtyCodes: ['cardiology'],
    });
    expect(replaced.status).toBe(200);
    expect(replaced.json).toMatchObject({
      doctor: { specialtyCodes: ['cardiology'] },
    });

    const state = await snapshot();
    expect(state.profiles).toEqual(profilesBefore);
    expect(await codesAt(ids.clinic, ids.doctor)).toEqual(['cardiology']);
    expect(await codesAt(ids.otherClinic, ids.doctor)).toEqual([]);
    expect(state.audits).toEqual([
      {
        clinic_id: ids.clinic,
        entity_id: ids.doctor,
        metadata: { specialtyCodes: ['pediatrics', 'general_medicine'] },
      },
      {
        clinic_id: ids.clinic,
        entity_id: ids.doctor,
        metadata: { specialtyCodes: ['cardiology'] },
      },
    ]);
  });

  it('is a no-op without audit when the codes are unchanged', async () => {
    const body = { specialtyCodes: ['dermatology', 'ent', 'dentistry'] };
    expect((await setSpecialties('ds-admin', body)).status).toBe(200);
    const before = await snapshot();
    const again = await setSpecialties('ds-admin', body);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ doctor: body });
    expect(await snapshot()).toEqual(before);
  });

  it('lets the same doctor hold different specialties at two clinics', async () => {
    expect(
      (await setSpecialties('ds-admin', { specialtyCodes: ['pediatrics'] }))
        .status,
    ).toBe(200);
    expect(
      (
        await setSpecialties(
          'ds-other-admin',
          { specialtyCodes: ['cardiology', 'internal_medicine'] },
          ids.doctor,
          ids.otherClinic,
        )
      ).status,
    ).toBe(200);
    expect(await codesAt(ids.clinic, ids.doctor)).toEqual(['pediatrics']);
    expect(await codesAt(ids.otherClinic, ids.doctor)).toEqual([
      'cardiology',
      'internal_medicine',
    ]);
    const mine = (await listDoctors('ds-admin')).json.doctors;
    expect(mine).toEqual([
      {
        id: ids.doctor,
        userId: ids.doctorUser,
        displayName: 'Dr Yacine',
        specialtyCodes: ['pediatrics'],
      },
    ]);
  });

  it('denies non-admin staff and other clinics without writing', async () => {
    const before = await snapshot();
    for (const subject of ['ds-receptionist', 'ds-doctor', 'ds-other-admin']) {
      const response = await setSpecialties(subject, {
        specialtyCodes: ['pediatrics'],
      });
      expect(response.status).toBe(403);
      expect(response.json).toMatchObject({ error: 'forbidden' });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('returns the same 404 for unknown, malformed and other-clinic-only doctors', async () => {
    const before = await snapshot();
    for (const doctorId of [ids.otherOnlyDoctor, randomUUID(), 'nope']) {
      const response = await setSpecialties(
        'ds-admin',
        { specialtyCodes: ['pediatrics'] },
        doctorId,
      );
      expect(response.status).toBe(404);
      expect(response.json).toMatchObject({
        error: 'not_found',
        message: 'Doctor not found',
      });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('rejects invalid bodies with 400 and writes nothing', async () => {
    const before = await snapshot();
    for (const body of [
      { specialtyCodes: [] },
      { specialtyCodes: ['pediatrics', 'ent', 'dentistry', 'cardiology'] },
      { specialtyCodes: ['pediatrics', 'pediatrics'] },
      { specialtyCodes: ['astrology'] },
      { specialtyCodes: ['Pediatrics'] },
      { specialtyCodes: [' pediatrics'] },
      { specialtyCodes: [null] },
      { specialtyCodes: [1] },
      { specialtyCodes: 'pediatrics' },
      { specialtyCodes: null },
      { specialtyCodes: ['pediatrics'], doctorId: ids.otherOnlyDoctor },
      {},
      'not json',
    ]) {
      const response = await setSpecialties('ds-admin', body);
      expect(response.status).toBe(400);
      expect(response.json).toMatchObject({ error: 'invalid_request' });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('accepts every code of the controlled list', async () => {
    for (const { code } of SPECIALTIES) {
      const response = await setSpecialties('ds-admin', {
        specialtyCodes: [code],
      });
      expect(response.status).toBe(200);
    }
  });
});
