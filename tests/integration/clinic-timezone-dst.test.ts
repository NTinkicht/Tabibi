import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { ClinicService, InvalidClinicTimezoneError } from '@/modules/clinic';
import { AuthorizationError } from '@/modules/identity';
import { SchedulingService } from '@/modules/scheduling';

// TAB-P0-02 (#643): a clinic timezone must be a named IANA zone known to
// PostgreSQL, and generated sessions land on the correct UTC instants across
// daylight-saving transitions (Europe/Paris: 2026-03-29 spring-forward,
// 2026-10-25 fall-back).
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

const ids = {
  clinic: randomUUID(),
  admin: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.admin };

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, clinic_closures, session_command_receipts,
    consultation_sessions, schedule_templates, doctor_clinics, doctor_profiles,
    clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'tz-admin', 'Admin'), ($2, 'tz-receptionist', 'Receptionist'),
       ($3, 'tz-doctor', 'Doctor')`,
    [ids.admin, ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'tz-clinic', 'Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $2, 'clinic_admin'), ($1, $3, 'receptionist'), ($1, $4, 'doctor')`,
    [ids.clinic, ids.admin, ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
    [ids.clinic, ids.doctor],
  );
});

afterAll(async () => pool.end());

async function clinicState() {
  const clinic = await pool.query(
    'SELECT name, timezone, status, updated_at FROM clinics WHERE id = $1',
    [ids.clinic],
  );
  const audit = await pool.query(
    'SELECT count(*)::int AS n FROM audit_events WHERE clinic_id = $1',
    [ids.clinic],
  );
  return { clinic: clinic.rows[0], audits: audit.rows[0]?.n };
}

describe('clinic timezone validation', () => {
  it.each([
    'Not/AZone',
    '',
    ' ',
    'UTC+1',
    '+01:00',
    'africa/algiers',
    'Africa/Algiers ',
    'Europe/Paris; DROP TABLE clinics',
  ])('rejects %j with nothing written', async (timezone) => {
    const before = await clinicState();
    await expect(
      new ClinicService(pool).updateClinic(scope, {
        name: 'Renamed',
        timezone,
        status: 'inactive',
      }),
    ).rejects.toBeInstanceOf(InvalidClinicTimezoneError);
    expect(await clinicState()).toEqual(before);
    expect(before.clinic.timezone).toBe('Africa/Algiers');
  });

  it('authorizes before validating the timezone', async () => {
    await expect(
      new ClinicService(pool).updateClinic(
        { clinicId: ids.clinic, actorUserId: ids.receptionist },
        { name: 'Renamed', timezone: 'Not/AZone' },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('accepts a known IANA zone, audits it, and keeps it when omitted', async () => {
    const clinics = new ClinicService(pool);
    await expect(
      clinics.updateClinic(scope, { name: 'Clinic', timezone: 'Europe/Paris' }),
    ).resolves.toMatchObject({ timezone: 'Europe/Paris' });
    await expect(
      clinics.updateClinic(scope, { name: 'Clinic 2' }),
    ).resolves.toMatchObject({ name: 'Clinic 2', timezone: 'Europe/Paris' });
    // An untyped caller passing null gets the same keep-current behaviour as
    // omission (the UPDATE uses COALESCE), not a validation error.
    await expect(
      clinics.updateClinic(scope, {
        name: 'Clinic 3',
        timezone: null as unknown as string,
      }),
    ).resolves.toMatchObject({ name: 'Clinic 3', timezone: 'Europe/Paris' });
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE clinic_id = $1 AND action = 'clinic.updated'`,
      [ids.clinic],
    );
    expect(audit.rows[0]?.n).toBe(3);
  });
});

describe('session generation across daylight-saving transitions', () => {
  async function planned(): Promise<
    Array<{ day: string; starts: string; ends: string }>
  > {
    const result = await pool.query<{
      service_date: string;
      starts_at: Date;
      ends_at: Date;
    }>(
      `SELECT service_date::text, starts_at, ends_at FROM consultation_sessions
        WHERE clinic_id = $1 ORDER BY starts_at`,
      [ids.clinic],
    );
    return result.rows.map((row) => ({
      day: row.service_date,
      starts: row.starts_at.toISOString(),
      ends: row.ends_at.toISOString(),
    }));
  }

  async function parisTemplates(
    templates: Array<[weekday: number, start: string, end: string]>,
  ) {
    await new ClinicService(pool).updateClinic(scope, {
      name: 'Clinic',
      timezone: 'Europe/Paris',
    });
    const schedules = new SchedulingService(pool);
    for (const [
      index,
      [weekday, localStartTime, localEndTime],
    ] of templates.entries()) {
      await schedules.createTemplate(scope, {
        doctorId: ids.doctor,
        weekday,
        localStartTime,
        localEndTime,
        occurrenceIndex: index,
      });
    }
    return schedules;
  }

  it('shifts UTC by one hour at spring-forward and keeps local hours', async () => {
    const schedules = await parisTemplates([
      [6, '09:00', '12:00'],
      [0, '09:00', '12:00'],
    ]);
    const generate = () =>
      schedules.generateSessions(scope, {
        doctorId: ids.doctor,
        startDate: '2026-03-21',
        daysAhead: 14,
      });
    expect(await generate()).toBe(4);
    expect(await planned()).toEqual([
      // CET (UTC+1)
      {
        day: '2026-03-21',
        starts: '2026-03-21T08:00:00.000Z',
        ends: '2026-03-21T11:00:00.000Z',
      },
      {
        day: '2026-03-22',
        starts: '2026-03-22T08:00:00.000Z',
        ends: '2026-03-22T11:00:00.000Z',
      },
      {
        day: '2026-03-28',
        starts: '2026-03-28T08:00:00.000Z',
        ends: '2026-03-28T11:00:00.000Z',
      },
      // Transition day and after: CEST (UTC+2)
      {
        day: '2026-03-29',
        starts: '2026-03-29T07:00:00.000Z',
        ends: '2026-03-29T10:00:00.000Z',
      },
    ]);
    expect(await generate()).toBe(0);
    expect(await planned()).toHaveLength(4);
  });

  it('shifts UTC back at fall-back and resolves the repeated hour deterministically', async () => {
    const schedules = await parisTemplates([
      [0, '09:00', '12:00'],
      [0, '02:30', '03:30'],
    ]);
    expect(
      await schedules.generateSessions(scope, {
        doctorId: ids.doctor,
        startDate: '2026-10-18',
        daysAhead: 8,
      }),
    ).toBe(4);
    expect(await planned()).toEqual([
      // CEST (UTC+2)
      {
        day: '2026-10-18',
        starts: '2026-10-18T00:30:00.000Z',
        ends: '2026-10-18T01:30:00.000Z',
      },
      {
        day: '2026-10-18',
        starts: '2026-10-18T07:00:00.000Z',
        ends: '2026-10-18T10:00:00.000Z',
      },
      // Fall-back day: 02:30 occurs twice; PostgreSQL resolves the ambiguous
      // local time to standard time (UTC+1), so the session keeps one hour.
      {
        day: '2026-10-25',
        starts: '2026-10-25T01:30:00.000Z',
        ends: '2026-10-25T02:30:00.000Z',
      },
      {
        day: '2026-10-25',
        starts: '2026-10-25T08:00:00.000Z',
        ends: '2026-10-25T11:00:00.000Z',
      },
    ]);
  });
});
