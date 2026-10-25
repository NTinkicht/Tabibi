import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  BOOKABLE_SESSION_HORIZON_DAYS,
  BOOKABLE_SESSIONS_PER_DOCTOR,
  PublicBookableSessionService,
} from '@/modules/public-availability';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const SECRET = 'tab-p0-03-bookable-sessions-test-secret-32-bytes-min';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

beforeAll(async () => migrate());

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_reorder_receipts, queue_command_receipts,
    queue_registration_receipts, queue_entries, appointments,
    appointment_booking_receipts, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
});

afterAll(async () => pool.end());

function selections(): PublicAvailabilitySelectionService {
  return new PublicAvailabilitySelectionService(pool, SECRET);
}

// Whole-hour instants relative to the real clock: the read model's horizon is
// evaluated by PostgreSQL now(), so fixtures must be relative to it.
const base = Math.ceil(Date.now() / HOUR_MS) * HOUR_MS;
function at(offsetMs: number): Date {
  return new Date(base + offsetMs);
}

async function seedDoctor(
  clinicId: string,
  displayName: string,
): Promise<string> {
  const userId = randomUUID();
  const doctorId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $3)`,
    [userId, `p003-${userId}`, `Internal ${displayName}`],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, $3)`,
    [doctorId, userId, displayName],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
    [clinicId, doctorId],
  );
  return doctorId;
}

async function seedClinic(
  name: string,
  status: 'active' | 'inactive' = 'active',
): Promise<string> {
  const clinicId = randomUUID();
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name, default_locale, enabled_locales, status)
     VALUES ($1, $2, $3, 'fr', ARRAY['fr','ar'], $4)`,
    [clinicId, `p003-tenant-${clinicId}`, name, status],
  );
  return clinicId;
}

async function seedSession(
  clinicId: string,
  doctorId: string,
  startsAt: Date,
  status = 'planned',
): Promise<string> {
  const sessionId = randomUUID();
  const endsAt = new Date(startsAt.getTime() + HOUR_MS);
  await pool.query(
    `INSERT INTO consultation_sessions
       (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4::date, $5, $6, $7)`,
    [
      sessionId,
      clinicId,
      doctorId,
      startsAt.toISOString().slice(0, 10),
      startsAt,
      endsAt,
      status,
    ],
  );
  return sessionId;
}

async function mutationCounts() {
  const result = await pool.query(`SELECT
      (SELECT count(*)::int FROM consultation_sessions) sessions,
      (SELECT count(*)::int FROM appointments) appointments,
      (SELECT count(*)::int FROM queue_entries) queue_entries,
      (SELECT count(*)::int FROM audit_events) audits`);
  return result.rows[0];
}

function window(startsAt: Date) {
  return {
    serviceDate: startsAt.toISOString().slice(0, 10),
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + HOUR_MS).toISOString(),
  };
}

describe('public bookable sessions (TAB-P0-03)', () => {
  it('returns only future bookable windows within the horizon, in the exact public shape', async () => {
    const clinic = await seedClinic('Clinique Bookable');
    const doctorZ = await seedDoctor(clinic, 'Dr Zed');
    const doctorA = await seedDoctor(clinic, 'Dr Alpha');
    const idleDoctor = await seedDoctor(clinic, 'Dr Idle');
    const inactiveClinic = await seedClinic('Clinique Cachée', 'inactive');
    const hiddenDoctor = await seedDoctor(inactiveClinic, 'Dr Hidden');
    await seedClinic('Clinique Sans Séance');

    // Inserted out of order to prove deterministic ordering.
    const later = at(2 * DAY_MS);
    const earlier = at(DAY_MS);
    const paused = at(3 * DAY_MS);
    const zed = at(DAY_MS + 2 * HOUR_MS);
    const ids = [
      await seedSession(clinic, doctorA, later, 'open'),
      await seedSession(clinic, doctorA, earlier),
      await seedSession(clinic, doctorA, paused, 'paused'),
      await seedSession(clinic, doctorZ, zed),
      // Excluded: terminal, already started, beyond the horizon, inactive clinic.
      await seedSession(clinic, doctorA, at(4 * DAY_MS), 'closed'),
      await seedSession(clinic, doctorA, at(5 * DAY_MS), 'cancelled'),
      await seedSession(clinic, doctorZ, at(-2 * HOUR_MS), 'open'),
      await seedSession(
        clinic,
        idleDoctor,
        at((BOOKABLE_SESSION_HORIZON_DAYS + 1) * DAY_MS),
      ),
      await seedSession(inactiveClinic, hiddenDoctor, at(DAY_MS)),
    ];
    const before = await mutationCounts();

    const result = await new PublicBookableSessionService(
      pool,
      selections(),
    ).list();

    expect(result).toEqual([
      {
        name: 'Clinique Bookable',
        defaultLocale: 'fr',
        enabledLocales: ['fr', 'ar'],
        doctors: [
          {
            displayName: 'Dr Alpha',
            sessions: [earlier, later, paused].map((startsAt) => ({
              ...window(startsAt),
              selectionReference: expect.stringMatching(/^v1\./),
            })),
          },
          {
            displayName: 'Dr Zed',
            sessions: [
              {
                ...window(zed),
                selectionReference: expect.stringMatching(/^v1\./),
              },
            ],
          },
        ],
      },
    ]);
    for (const doctor of result[0]!.doctors) {
      for (const session of doctor.sessions) {
        expect(Object.keys(session).sort()).toEqual([
          'endsAt',
          'selectionReference',
          'serviceDate',
          'startsAt',
        ]);
      }
    }

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      clinic,
      inactiveClinic,
      doctorA,
      doctorZ,
      idleDoctor,
      hiddenDoctor,
      ...ids,
      `p003-tenant-${clinic}`,
      'Internal Dr Alpha',
      'Clinique Cachée',
      'Clinique Sans Séance',
      'Dr Hidden',
      'Dr Idle',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(await mutationCounts()).toEqual(before);
  });

  it('issues references that resolve to exactly their own window', async () => {
    const clinic = await seedClinic('Clinique Resolve');
    const doctor = await seedDoctor(clinic, 'Dr Resolve');
    const first = at(DAY_MS);
    const second = at(2 * DAY_MS);
    const firstId = await seedSession(clinic, doctor, first);
    await seedSession(clinic, doctor, second);
    const service = selections();

    const [result] = await new PublicBookableSessionService(
      pool,
      service,
    ).list();
    const sessions = result!.doctors[0]!.sessions;

    expect(await service.resolve(sessions[0]!.selectionReference)).toEqual(
      window(first),
    );
    expect(await service.resolve(sessions[1]!.selectionReference)).toEqual(
      window(second),
    );
    expect(
      await service.resolveForMutation(sessions[0]!.selectionReference),
    ).toMatchObject({ clinicId: clinic, doctorId: doctor, sessionId: firstId });

    // The reference is not authority: it fails closed once durable truth moves.
    await pool.query(
      `UPDATE consultation_sessions SET status = 'cancelled' WHERE id = $1`,
      [firstId],
    );
    expect(await service.resolve(sessions[0]!.selectionReference)).toBeNull();
  });

  it('bounds each doctor to the next sessions and keeps same-name clinics separate', async () => {
    const clinicA = await seedClinic('Clinique Partagée');
    const clinicB = await seedClinic('Clinique Partagée');
    const doctorA = await seedDoctor(clinicA, 'Dr Busy');
    const doctorB = await seedDoctor(clinicB, 'Dr Busy');
    const starts = Array.from(
      { length: BOOKABLE_SESSIONS_PER_DOCTOR + 2 },
      (_, index) => at((index + 1) * DAY_MS),
    );
    for (const startsAt of [...starts].reverse()) {
      await seedSession(clinicA, doctorA, startsAt);
    }
    await seedSession(clinicB, doctorB, at(DAY_MS + 3 * HOUR_MS));

    const result = await new PublicBookableSessionService(
      pool,
      selections(),
    ).list();

    expect(result).toHaveLength(2);
    expect(result.every((clinic) => clinic.name === 'Clinique Partagée')).toBe(
      true,
    );
    const sessionCounts = result
      .map((clinic) => clinic.doctors[0]!.sessions.length)
      .sort();
    expect(sessionCounts).toEqual([1, BOOKABLE_SESSIONS_PER_DOCTOR]);
    const busy = result.find(
      (clinic) =>
        clinic.doctors[0]!.sessions.length === BOOKABLE_SESSIONS_PER_DOCTOR,
    )!;
    expect(busy.doctors[0]!.sessions.map((s) => s.startsAt)).toEqual(
      starts
        .slice(0, BOOKABLE_SESSIONS_PER_DOCTOR)
        .map((d) => d.toISOString()),
    );
  });

  it('returns an empty list when nothing is bookable', async () => {
    await seedClinic('Clinique Vide');
    expect(
      await new PublicBookableSessionService(pool, selections()).list(),
    ).toEqual([]);
  });
});
