import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
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
  describe('TAB-P0-03 available-session filter (#692)', () => {
    const available = { availableOnly: true } as const;
    const names = (
      clinics: Awaited<ReturnType<PublicDiscoveryService['listClinics']>>,
    ) =>
      clinics.map((clinic) => [
        clinic.name,
        clinic.doctors.map((doctor) => doctor.displayName),
      ]);

    // Two active clinics (Algiers, Oran), one inactive; Dr Cardio works at
    // both active clinics, Dr Kids only in Algiers, Dr Hidden at the
    // inactive clinic. No sessions yet.
    async function seed() {
      const ids = Array.from({ length: 9 }, () => randomUUID());
      const [algiers, oran, hidden, u1, u2, u3, cardio, kids, hiddenDoctor] =
        ids;
      await pool.query(
        `INSERT INTO users (id, auth_subject, display_name) VALUES
          ($1, 'p692-u1', 'U1'), ($2, 'p692-u2', 'U2'), ($3, 'p692-u3', 'U3')`,
        [u1, u2, u3],
      );
      await pool.query(
        `INSERT INTO clinics (id, tenant_key, name, status, wilaya_code) VALUES
          ($1, 'p692-alg', 'Alger Centre', 'active', '16'),
          ($2, 'p692-ora', 'Oran Clinic', 'active', '31'),
          ($3, 'p692-hidden', 'Hidden Clinic', 'inactive', '16')`,
        [algiers, oran, hidden],
      );
      await pool.query(
        `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
          ($1, $4, 'Dr Cardio'), ($2, $5, 'Dr Kids'), ($3, $6, 'Dr Hidden')`,
        [cardio, kids, hiddenDoctor, u1, u2, u3],
      );
      await pool.query(
        `INSERT INTO doctor_clinics (clinic_id, doctor_id, specialty_codes) VALUES
          ($1, $4, ARRAY['cardiology']),
          ($1, $5, ARRAY['pediatrics']),
          ($2, $4, ARRAY['cardiology']),
          ($3, $6, ARRAY['cardiology'])`,
        [algiers, oran, hidden, cardio, kids, hiddenDoctor],
      );
      return { ids, algiers, oran, hidden, cardio, kids, hiddenDoctor };
    }

    // `startsAt` is a SQL expression evaluated by PostgreSQL so it is
    // relative to the same clock as the discovery predicate.
    async function session(
      db: Pool | PoolClient,
      clinicId: string,
      doctorId: string,
      startsAt: string,
      status = 'planned',
    ) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO consultation_sessions
           (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
         SELECT $1, $2, $3, (s.at)::date, s.at, s.at + interval '2 hours', $4::session_status
           FROM (SELECT ${startsAt} AS at) s`,
        [id, clinicId, doctorId, status],
      );
      return id;
    }

    const service = () => new PublicDiscoveryService(pool);

    it('returns nothing when no doctor has a bookable session, and leaves unfiltered discovery unchanged', async () => {
      await seed();
      expect(
        await service().listClinics(undefined, undefined, available),
      ).toEqual([]);
      expect(names(await service().listClinics())).toEqual([
        ['Alger Centre', ['Dr Cardio', 'Dr Kids']],
        ['Oran Clinic', ['Dr Cardio']],
      ]);
      expect(
        names(
          await service().listClinics(undefined, undefined, {
            availableOnly: false,
          }),
        ),
      ).toEqual(names(await service().listClinics()));
    });

    it('matches planned, open and paused sessions inside the horizon', async () => {
      for (const status of ['planned', 'open', 'paused']) {
        await pool.query(
          'TRUNCATE consultation_sessions, doctor_clinics, doctor_profiles, clinics, users CASCADE',
        );
        const { algiers, kids } = await seed();
        await session(pool, algiers, kids, `now() + interval '3 days'`, status);
        expect(
          names(await service().listClinics(undefined, undefined, available)),
          status,
        ).toEqual([['Alger Centre', ['Dr Kids']]]);
      }
    });

    it('ignores closed and cancelled, past and beyond-horizon sessions', async () => {
      const { algiers, oran, cardio, kids } = await seed();
      await session(pool, algiers, kids, `now() + interval '1 day'`, 'closed');
      await session(
        pool,
        algiers,
        kids,
        `now() + interval '1 day'`,
        'cancelled',
      );
      await session(pool, algiers, cardio, `now() - interval '1 minute'`);
      await session(pool, oran, cardio, `now() + interval '15 days'`);
      expect(
        await service().listClinics(undefined, undefined, available),
      ).toEqual([]);
    });

    it('excludes a session starting exactly now or exactly at the horizon', async () => {
      const { algiers, kids } = await seed();
      const client = await pool.connect();
      try {
        // Inside one transaction now() is fixed, so the boundaries are exact.
        await client.query('BEGIN');
        const inTransaction = new PublicDiscoveryService(
          client as unknown as Pool,
        );
        await session(client, algiers, kids, 'now()');
        await session(client, algiers, kids, `now() + interval '14 days'`);
        expect(
          await inTransaction.listClinics(undefined, undefined, available),
        ).toEqual([]);
        await session(
          client,
          algiers,
          kids,
          `now() + interval '14 days' - interval '1 second'`,
        );
        expect(
          names(
            await inTransaction.listClinics(undefined, undefined, available),
          ),
        ).toEqual([['Alger Centre', ['Dr Kids']]]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('never matches an inactive clinic and scopes availability to the clinic of the session', async () => {
      const { hidden, oran, cardio, hiddenDoctor } = await seed();
      await session(pool, hidden, hiddenDoctor, `now() + interval '1 day'`);
      // Dr Cardio's session is at Oran only: Alger Centre must not list them.
      await session(pool, oran, cardio, `now() + interval '1 day'`);
      expect(
        names(await service().listClinics(undefined, undefined, available)),
      ).toEqual([['Oran Clinic', ['Dr Cardio']]]);
    });

    it('lists only the available doctors of a clinic and composes with wilaya and specialty', async () => {
      const { algiers, oran, cardio, kids } = await seed();
      await session(pool, algiers, kids, `now() + interval '2 days'`);
      await session(pool, oran, cardio, `now() + interval '2 days'`);
      expect(
        names(await service().listClinics(undefined, undefined, available)),
      ).toEqual([
        ['Alger Centre', ['Dr Kids']],
        ['Oran Clinic', ['Dr Cardio']],
      ]);
      expect(
        names(
          await service().listClinics(undefined, undefined, {
            ...available,
            wilayaCode: '16',
          }),
        ),
      ).toEqual([['Alger Centre', ['Dr Kids']]]);
      // Dr Cardio holds cardiology in Algiers but is only available in Oran;
      // the specialty and availability must hold for the same doctor.
      expect(
        names(
          await service().listClinics(undefined, undefined, {
            ...available,
            specialtyCode: 'cardiology',
          }),
        ),
      ).toEqual([['Oran Clinic', ['Dr Cardio']]]);
      expect(
        await service().listClinics(undefined, undefined, {
          ...available,
          wilayaCode: '16',
          specialtyCode: 'cardiology',
        }),
      ).toEqual([]);
      // Abortable query path applies the same filter.
      expect(
        names(
          await service().listClinics(undefined, new AbortController().signal, {
            ...available,
            specialtyCode: 'pediatrics',
          }),
        ),
      ).toEqual([['Alger Centre', ['Dr Kids']]]);
    });

    it('keeps the projection allow-list and leaks no identifier or session time', async () => {
      const { ids, algiers, kids } = await seed();
      const sessionId = await session(
        pool,
        algiers,
        kids,
        `now() + interval '4 days'`,
      );
      const {
        rows: [row],
      } = await pool.query<{ starts_at: Date; service_date: string }>(
        `SELECT starts_at, service_date::text AS service_date
           FROM consultation_sessions WHERE id = $1`,
        [sessionId],
      );
      const result = await service().listClinics(
        undefined,
        undefined,
        available,
      );
      expect(result).toEqual([
        {
          name: 'Alger Centre',
          defaultLocale: 'ar',
          enabledLocales: ['ar', 'fr'],
          wilayaCode: '16',
          commune: null,
          addressLine: null,
          doctors: [{ displayName: 'Dr Kids', specialtyCodes: ['pediatrics'] }],
        },
      ]);
      const serialized = JSON.stringify(result);
      for (const forbidden of [
        ...ids,
        sessionId,
        row.starts_at.toISOString(),
        row.service_date,
        'p692-',
        'Hidden Clinic',
        'Dr Hidden',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('refuses a non-boolean availability flag', async () => {
      await seed();
      for (const availableOnly of ['true', 1, null]) {
        await expect(
          service().listClinics(undefined, undefined, {
            availableOnly,
          } as unknown as { availableOnly: boolean }),
        ).rejects.toBeInstanceOf(InvalidDiscoveryFilterError);
      }
    });
  });

  // TAB-P0-03 (#694): server-fixed pages of 20 clinics, paged before doctors
  // are joined, ordered by (name, id), with a look-ahead hasMore only.
  describe('pagination', () => {
    const service = () => new PublicDiscoveryService(pool);

    async function seedClinics(
      count: number,
      name: (index: number) => string,
      wilaya = '16',
    ): Promise<string[]> {
      const ids = Array.from({ length: count }, () => randomUUID());
      await pool.query(
        `INSERT INTO clinics
          (id, tenant_key, name, default_locale, enabled_locales, status, wilaya_code)
         SELECT id, 'wu694-' || id::text, name, 'fr', ARRAY['fr'], 'active', $3
           FROM unnest($1::uuid[], $2::text[]) AS input(id, name)`,
        [ids, ids.map((_, index) => name(index)), wilaya],
      );
      return ids;
    }

    async function seedDoctors(clinicId: string, count: number) {
      const users = Array.from({ length: count }, () => randomUUID());
      const doctors = Array.from({ length: count }, () => randomUUID());
      await pool.query(
        `INSERT INTO users (id, auth_subject, display_name)
         SELECT id, 'wu694-' || id::text, 'Internal' FROM unnest($1::uuid[]) AS u(id)`,
        [users],
      );
      await pool.query(
        `INSERT INTO doctor_profiles (id, user_id, display_name)
         SELECT d, u, 'Dr ' || lpad(n::text, 2, '0')
           FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY AS x(d, u, n)`,
        [doctors, users],
      );
      await pool.query(
        `INSERT INTO doctor_clinics (clinic_id, doctor_id, specialty_codes)
         SELECT $1, d, ARRAY['cardiology'] FROM unnest($2::uuid[]) AS x(d)`,
        [clinicId, doctors],
      );
    }

    const pad = (index: number) => `Clinique ${String(index).padStart(2, '0')}`;
    const names = (page: { clinics: { name: string }[] }) =>
      page.clinics.map((clinic) => clinic.name);

    it('returns an empty first page without hasMore when nothing matches', async () => {
      expect(
        await service().listClinicsPage(undefined, undefined, {}, 1),
      ).toEqual({ clinics: [], hasMore: false });
    });

    it('fills exactly one page of 20 without hasMore', async () => {
      await seedClinics(20, pad);
      const first = await service().listClinicsPage(
        undefined,
        undefined,
        {},
        1,
      );
      expect(names(first)).toEqual(
        Array.from({ length: 20 }, (_, i) => pad(i)),
      );
      expect(first.hasMore).toBe(false);
      expect(
        await service().listClinicsPage(undefined, undefined, {}, 2),
      ).toEqual({ clinics: [], hasMore: false });
    });

    it('splits 41 clinics into 20, 20 and 1 with stable ordering', async () => {
      await seedClinics(41, pad);
      const pages = [];
      for (const page of [1, 2, 3, 4]) {
        pages.push(
          await service().listClinicsPage(undefined, undefined, {}, page),
        );
      }
      expect(pages.map((page) => page.clinics.length)).toEqual([20, 20, 1, 0]);
      expect(pages.map((page) => page.hasMore)).toEqual([
        true,
        true,
        false,
        false,
      ]);
      expect(pages.flatMap(names)).toEqual(
        Array.from({ length: 41 }, (_, i) => pad(i)),
      );
      expect(pages.flatMap(names)).toEqual(
        names({ clinics: await service().listClinics() }),
      );
    });

    it('orders equal names by clinic id so no clinic repeats or disappears', async () => {
      const ids = await seedClinics(21, () => 'Clinique Homonyme');
      for (const id of ids.slice(0, 5)) await seedDoctors(id, 1);
      const first = await service().listClinicsPage(
        undefined,
        undefined,
        {},
        1,
      );
      const second = await service().listClinicsPage(
        undefined,
        undefined,
        {},
        2,
      );
      expect([first.clinics.length, second.clinics.length]).toEqual([20, 1]);
      const unpaged = await service().listClinics();
      expect([...first.clinics, ...second.clinics]).toEqual(unpaged);
    });

    it('never splits a clinic with many doctors across pages', async () => {
      const [crowded] = await seedClinics(1, () => 'Clinique 00 Crowded');
      await seedClinics(20, (i) => pad(i + 1));
      await seedDoctors(crowded!, 25);
      const first = await service().listClinicsPage(
        undefined,
        undefined,
        {},
        1,
      );
      expect(first.clinics).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(first.clinics[0]!.name).toBe('Clinique 00 Crowded');
      expect(first.clinics[0]!.doctors.map((d) => d.displayName)).toEqual(
        Array.from(
          { length: 25 },
          (_, i) => `Dr ${String(i + 1).padStart(2, '0')}`,
        ),
      );
      const second = await service().listClinicsPage(
        undefined,
        undefined,
        {},
        2,
      );
      expect(names(second)).toEqual([pad(20)]);
      expect(second.hasMore).toBe(false);
    });

    it('pages only the clinics that match the filters', async () => {
      await seedClinics(25, pad, '16');
      await seedClinics(25, (i) => `Oran ${String(i).padStart(2, '0')}`, '31');
      const oranFirst = await service().listClinicsPage(
        undefined,
        undefined,
        { wilayaCode: '31' },
        1,
      );
      const oranSecond = await service().listClinicsPage(
        undefined,
        undefined,
        { wilayaCode: '31' },
        2,
      );
      expect([...names(oranFirst), ...names(oranSecond)]).toEqual(
        Array.from(
          { length: 25 },
          (_, i) => `Oran ${String(i).padStart(2, '0')}`,
        ),
      );
      expect([oranFirst.hasMore, oranSecond.hasMore]).toEqual([true, false]);
      expect(
        await service().listClinicsPage(
          undefined,
          undefined,
          { wilayaCode: '16', specialtyCode: 'cardiology' },
          1,
        ),
      ).toEqual({ clinics: [], hasMore: false });
    });

    it('serializes no identifier, count or tenant key in a page', async () => {
      const ids = await seedClinics(21, pad);
      await seedDoctors(ids[0]!, 2);
      const serialized = JSON.stringify(
        await service().listClinicsPage(undefined, undefined, {}, 1),
      );
      for (const id of ids) expect(serialized).not.toContain(id);
      expect(serialized).not.toContain('wu694-');
      expect(Object.keys(JSON.parse(serialized)).sort()).toEqual([
        'clinics',
        'hasMore',
      ]);
    });

    it('refuses pages outside 1..500 before querying', async () => {
      for (const page of [0, -1, 1.5, 501, Number.NaN, Infinity]) {
        await expect(
          service().listClinicsPage(undefined, undefined, {}, page),
        ).rejects.toBeInstanceOf(InvalidDiscoveryFilterError);
      }
    });
  });
});
