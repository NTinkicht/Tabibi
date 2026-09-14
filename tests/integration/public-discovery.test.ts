import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { PublicDiscoveryService } from '@/modules/clinic';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

beforeAll(async () => migrate());

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_reorder_receipts, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
});

afterAll(async () => pool.end());

describe('public clinic and doctor discovery', () => {
  it('returns deterministic active-clinic projections without internal identifiers', async () => {
    const clinicA = randomUUID();
    const clinicB = randomUUID();
    const inactiveClinic = randomUUID();
    const doctorAUser = randomUUID();
    const doctorBUser = randomUUID();
    const doctorCUser = randomUUID();
    const doctorA = randomUUID();
    const doctorB = randomUUID();
    const doctorC = randomUUID();

    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES
        ($1, 'wu56-doctor-b', 'Internal User B'),
        ($2, 'wu56-doctor-a', 'Internal User A'),
        ($3, 'wu56-doctor-c', 'Internal User C')`,
      [doctorBUser, doctorAUser, doctorCUser],
    );

    // Deliberately insert in non-sorted order to prove read-model ordering.
    await pool.query(
      `INSERT INTO clinics
        (id, tenant_key, name, default_locale, enabled_locales, status)
       VALUES
        ($1, 'wu56-b', 'Clinique B', 'fr', ARRAY['fr','ar'], 'active'),
        ($2, 'wu56-inactive', 'Clinique Cachée', 'fr', ARRAY['fr'], 'inactive'),
        ($3, 'wu56-a', 'عيادة أ', 'ar', ARRAY['ar','fr'], 'active')`,
      [clinicB, inactiveClinic, clinicA],
    );

    await pool.query(
      `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
        ($1, $2, 'Dr Zed'),
        ($3, $4, 'Dr Alpha'),
        ($5, $6, 'Dr Hidden')`,
      [doctorB, doctorBUser, doctorA, doctorAUser, doctorC, doctorCUser],
    );

    await pool.query(
      `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES
        ($1, $2),
        ($3, $4),
        ($5, $6)`,
      [clinicB, doctorB, clinicA, doctorA, inactiveClinic, doctorC],
    );

    const result = await new PublicDiscoveryService(pool).listClinics();

    expect(result).toEqual([
      {
        name: 'Clinique B',
        defaultLocale: 'fr',
        enabledLocales: ['fr', 'ar'],
        doctors: [{ displayName: 'Dr Zed' }],
      },
      {
        name: 'عيادة أ',
        defaultLocale: 'ar',
        enabledLocales: ['ar', 'fr'],
        doctors: [{ displayName: 'Dr Alpha' }],
      },
    ]);

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      clinicA,
      clinicB,
      inactiveClinic,
      doctorA,
      doctorB,
      doctorC,
      doctorAUser,
      doctorBUser,
      doctorCUser,
      'wu56-a',
      'wu56-b',
      'wu56-inactive',
      'Internal User A',
      'Internal User B',
      'Internal User C',
      'Clinique Cachée',
      'Dr Hidden',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('keeps doctors attached only to their associated active clinic', async () => {
    const clinicA = randomUUID();
    const clinicB = randomUUID();
    const doctorAUser = randomUUID();
    const doctorBUser = randomUUID();
    const doctorA = randomUUID();
    const doctorB = randomUUID();

    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES
        ($1, 'wu56-a-user', 'A'), ($2, 'wu56-b-user', 'B')`,
      [doctorAUser, doctorBUser],
    );
    await pool.query(
      `INSERT INTO clinics (id, tenant_key, name) VALUES
        ($1, 'wu56-alpha', 'Alpha Clinic'), ($2, 'wu56-beta', 'Beta Clinic')`,
      [clinicA, clinicB],
    );
    await pool.query(
      `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
        ($1, $2, 'Doctor Alpha'), ($3, $4, 'Doctor Beta')`,
      [doctorA, doctorAUser, doctorB, doctorBUser],
    );
    await pool.query(
      `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2), ($3, $4)`,
      [clinicA, doctorA, clinicB, doctorB],
    );

    const result = await new PublicDiscoveryService(pool).listClinics();
    expect(
      result.find((clinic) => clinic.name === 'Alpha Clinic')?.doctors,
    ).toEqual([{ displayName: 'Doctor Alpha' }]);
    expect(
      result.find((clinic) => clinic.name === 'Beta Clinic')?.doctors,
    ).toEqual([{ displayName: 'Doctor Beta' }]);
  });

  it('keeps same-name clinics separate by internal clinic identity', async () => {
    const clinicA = randomUUID();
    const clinicB = randomUUID();
    const doctorAUser = randomUUID();
    const doctorBUser = randomUUID();
    const doctorA = randomUUID();
    const doctorB = randomUUID();

    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES
        ($1, 'wu56-collision-a-user', 'Collision A'),
        ($2, 'wu56-collision-b-user', 'Collision B')`,
      [doctorAUser, doctorBUser],
    );
    await pool.query(
      `INSERT INTO clinics (id, tenant_key, name) VALUES
        ($1, 'wu56-collision-a', 'Shared Clinic'),
        ($2, 'wu56-collision-b', 'Shared Clinic')`,
      [clinicA, clinicB],
    );
    await pool.query(
      `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
        ($1, $2, 'Doctor One'), ($3, $4, 'Doctor Two')`,
      [doctorA, doctorAUser, doctorB, doctorBUser],
    );
    await pool.query(
      `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2), ($3, $4)`,
      [clinicA, doctorA, clinicB, doctorB],
    );

    const result = await new PublicDiscoveryService(pool).listClinics();

    expect(result).toHaveLength(2);
    expect(result.every((clinic) => clinic.name === 'Shared Clinic')).toBe(true);
    expect(result.map((clinic) => clinic.doctors)).toEqual(
      expect.arrayContaining([
        [{ displayName: 'Doctor One' }],
        [{ displayName: 'Doctor Two' }],
      ]),
    );

    const serialized = JSON.stringify(result);
    for (const forbidden of [clinicA, clinicB, doctorA, doctorB]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
