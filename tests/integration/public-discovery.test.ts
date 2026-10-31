import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  InvalidDiscoveryFilterError,
  PublicDiscoveryService,
} from '@/modules/clinic';

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
        wilayaCode: null,
        commune: null,
        addressLine: null,
        doctors: [{ displayName: 'Dr Zed', specialtyCodes: [] }],
      },
      {
        name: 'عيادة أ',
        defaultLocale: 'ar',
        enabledLocales: ['ar', 'fr'],
        wilayaCode: null,
        commune: null,
        addressLine: null,
        doctors: [{ displayName: 'Dr Alpha', specialtyCodes: [] }],
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
    ).toEqual([{ displayName: 'Doctor Alpha', specialtyCodes: [] }]);
    expect(
      result.find((clinic) => clinic.name === 'Beta Clinic')?.doctors,
    ).toEqual([{ displayName: 'Doctor Beta', specialtyCodes: [] }]);
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
    expect(result.every((clinic) => clinic.name === 'Shared Clinic')).toBe(
      true,
    );
    expect(result.map((clinic) => clinic.doctors)).toEqual(
      expect.arrayContaining([
        [{ displayName: 'Doctor One', specialtyCodes: [] }],
        [{ displayName: 'Doctor Two', specialtyCodes: [] }],
      ]),
    );

    const serialized = JSON.stringify(result);
    for (const forbidden of [clinicA, clinicB, doctorA, doctorB]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  describe('TAB-P0-03 wilaya and specialty filters (#688)', () => {
    async function seed() {
      const ids = Array.from({ length: 12 }, () => randomUUID());
      const [algiers, oran, unlocated, hidden] = ids;
      const users = ids.slice(4, 8);
      const doctors = ids.slice(8, 12);
      await pool.query(
        `INSERT INTO users (id, auth_subject, display_name) VALUES
          ($1, 'p003-u1', 'U1'), ($2, 'p003-u2', 'U2'),
          ($3, 'p003-u3', 'U3'), ($4, 'p003-u4', 'U4')`,
        users,
      );
      await pool.query(
        `INSERT INTO clinics
          (id, tenant_key, name, status, wilaya_code, commune, address_line)
         VALUES
          ($1, 'p003-alg', 'Alger Centre', 'active', '16', 'Bab Ezzouar', '12 rue A'),
          ($2, 'p003-ora', 'Oran Clinic', 'active', '31', 'Es Senia', NULL),
          ($3, 'p003-none', 'No Location', 'active', NULL, NULL, NULL),
          ($4, 'p003-hidden', 'Hidden Algiers', 'inactive', '16', 'Kouba', NULL)`,
        [algiers, oran, unlocated, hidden],
      );
      await pool.query(
        `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
          ($1, $5, 'Dr Cardio'), ($2, $6, 'Dr Kids'),
          ($3, $7, 'Dr Oran'), ($4, $8, 'Dr Hidden')`,
        [...doctors, ...users],
      );
      // The same doctor (Dr Cardio) holds different specialties at two clinics.
      await pool.query(
        `INSERT INTO doctor_clinics (clinic_id, doctor_id, specialty_codes) VALUES
          ($1, $5, ARRAY['cardiology', 'internal_medicine']),
          ($1, $6, ARRAY['pediatrics']),
          ($2, $5, ARRAY['general_medicine']),
          ($2, $7, ARRAY['cardiology']),
          ($3, $6, ARRAY['cardiology']),
          ($4, $8, ARRAY['cardiology'])`,
        [algiers, oran, unlocated, hidden, ...doctors],
      );
      return ids;
    }

    const service = () => new PublicDiscoveryService(pool);
    const summary = (
      clinics: Awaited<ReturnType<PublicDiscoveryService['listClinics']>>,
    ) =>
      clinics.map((clinic) => [
        clinic.name,
        clinic.doctors.map((doctor) => doctor.displayName),
      ]);

    it('lists each clinic location and per-association specialty codes', async () => {
      await seed();
      const result = await service().listClinics();
      expect(result.find((c) => c.name === 'Alger Centre')).toEqual({
        name: 'Alger Centre',
        defaultLocale: 'ar',
        enabledLocales: ['ar', 'fr'],
        wilayaCode: '16',
        commune: 'Bab Ezzouar',
        addressLine: '12 rue A',
        doctors: [
          {
            displayName: 'Dr Cardio',
            specialtyCodes: ['cardiology', 'internal_medicine'],
          },
          { displayName: 'Dr Kids', specialtyCodes: ['pediatrics'] },
        ],
      });
      expect(result.find((c) => c.name === 'Oran Clinic')?.doctors).toEqual([
        { displayName: 'Dr Cardio', specialtyCodes: ['general_medicine'] },
        { displayName: 'Dr Oran', specialtyCodes: ['cardiology'] },
      ]);
    });

    it('filters by wilaya and never matches a clinic without a location', async () => {
      await seed();
      expect(
        summary(
          await service().listClinics(undefined, undefined, {
            wilayaCode: '16',
          }),
        ),
      ).toEqual([['Alger Centre', ['Dr Cardio', 'Dr Kids']]]);
      expect(
        summary(
          await service().listClinics(undefined, undefined, {
            wilayaCode: '05',
          }),
        ),
      ).toEqual([]);
    });

    it('filters by specialty at the clinic, listing only the matching doctors', async () => {
      await seed();
      expect(
        summary(
          await service().listClinics(undefined, undefined, {
            specialtyCode: 'cardiology',
          }),
        ),
      ).toEqual([
        ['Alger Centre', ['Dr Cardio']],
        ['No Location', ['Dr Kids']],
        ['Oran Clinic', ['Dr Oran']],
      ]);
      expect(
        summary(
          await service().listClinics(undefined, undefined, {
            specialtyCode: 'dermatology',
          }),
        ),
      ).toEqual([]);
    });

    it('combines both filters', async () => {
      await seed();
      expect(
        summary(
          await service().listClinics(undefined, undefined, {
            wilayaCode: '31',
            specialtyCode: 'cardiology',
          }),
        ),
      ).toEqual([['Oran Clinic', ['Dr Oran']]]);
      expect(
        summary(
          await service().listClinics(undefined, undefined, {
            wilayaCode: '31',
            specialtyCode: 'pediatrics',
          }),
        ),
      ).toEqual([]);
    });

    it('applies filters through the abortable query path too', async () => {
      await seed();
      const result = await service().listClinics(
        undefined,
        new AbortController().signal,
        { wilayaCode: '16', specialtyCode: 'pediatrics' },
      );
      expect(summary(result)).toEqual([['Alger Centre', ['Dr Kids']]]);
    });

    it('refuses uncontrolled filter values without querying and leaks no identifiers', async () => {
      const ids = await seed();
      for (const filters of [
        { wilayaCode: '59' },
        { wilayaCode: '' },
        { specialtyCode: 'Cardiology' },
        { specialtyCode: "cardiology' OR 1=1 --" },
      ]) {
        await expect(
          service().listClinics(undefined, undefined, filters),
        ).rejects.toBeInstanceOf(InvalidDiscoveryFilterError);
      }
      const serialized = JSON.stringify(
        await service().listClinics(undefined, undefined, {
          specialtyCode: 'cardiology',
        }),
      );
      for (const forbidden of [
        ...ids,
        'p003-',
        'Hidden Algiers',
        'Dr Hidden',
        'Kouba',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  });
});
