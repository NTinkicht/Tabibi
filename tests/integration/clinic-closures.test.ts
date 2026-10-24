import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AuthorizationError } from '@/modules/identity';
import {
  ClinicClosureConflictError,
  SchedulingService,
} from '@/modules/scheduling';

// TAB-P0-02 (#638): clinic closure days (holidays). Generation plans nothing on
// a closure day, closures are clinic-scoped and admin-only, and a closure can
// never coexist with a non-cancelled session of that clinic on that day.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  otherAdmin: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  outsider: randomUUID(),
  doctor: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.admin };
const otherScope = { clinicId: ids.otherClinic, actorUserId: ids.otherAdmin };
const MONDAY = '2026-09-07';
const TUESDAY = '2026-09-08';

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, clinic_closures, consultation_sessions,
    schedule_templates, doctor_clinics, doctor_profiles, clinic_memberships,
    clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'closure-admin', 'Admin'), ($2, 'closure-other-admin', 'Other Admin'),
       ($3, 'closure-receptionist', 'Receptionist'),
       ($4, 'closure-doctor', 'Doctor'), ($5, 'closure-outsider', 'Outsider')`,
    [ids.admin, ids.otherAdmin, ids.receptionist, ids.doctorUser, ids.outsider],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'closure-clinic', 'Clinic'), ($2, 'closure-other-clinic', 'Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($1, $4, 'receptionist'), ($1, $5, 'doctor'),
       ($2, $6, 'clinic_admin'), ($2, $5, 'doctor')`,
    [
      ids.clinic,
      ids.otherClinic,
      ids.admin,
      ids.receptionist,
      ids.doctorUser,
      ids.otherAdmin,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $3), ($2, $3)`,
    [ids.clinic, ids.otherClinic, ids.doctor],
  );
  const schedules = new SchedulingService(pool);
  for (const s of [scope, otherScope]) {
    for (const weekday of [1, 2]) {
      await schedules.createTemplate(s, {
        doctorId: ids.doctor,
        weekday,
        localStartTime: '09:00',
        localEndTime: '12:00',
        occurrenceIndex: 0,
      });
    }
  }
});

afterAll(async () => pool.end());

function generate(s = scope) {
  return new SchedulingService(pool).generateSessions(s, {
    doctorId: ids.doctor,
    startDate: MONDAY,
    daysAhead: 14,
  });
}

async function sessionDays(clinicId: string): Promise<string[]> {
  const result = await pool.query<{ service_date: string }>(
    `SELECT service_date::text FROM consultation_sessions
      WHERE clinic_id = $1 AND status <> 'cancelled' ORDER BY service_date`,
    [clinicId],
  );
  return result.rows.map((row) => row.service_date);
}

async function snapshot() {
  const closures = await pool.query(
    'SELECT clinic_id, closure_date::text FROM clinic_closures ORDER BY 1, 2',
  );
  const audits = await pool.query<{ metadata: unknown }>(
    `SELECT clinic_id, actor_user_id, entity_type, entity_id, metadata
       FROM audit_events WHERE action = 'clinic_closure.created' ORDER BY id`,
  );
  return { closures: closures.rows, audits: audits.rows };
}

describe('clinic closure days', () => {
  it('skips a closure day during generation and keeps other days and clinics', async () => {
    const schedules = new SchedulingService(pool);
    expect(await schedules.addClosure(scope, MONDAY)).toEqual({
      closureDate: MONDAY,
      created: true,
    });

    expect(await generate()).toBe(3);
    expect(await sessionDays(ids.clinic)).toEqual([
      TUESDAY,
      '2026-09-14',
      '2026-09-15',
    ]);
    expect(await generate(otherScope)).toBe(4);
    expect(await sessionDays(ids.otherClinic)).toEqual([
      MONDAY,
      TUESDAY,
      '2026-09-14',
      '2026-09-15',
    ]);
    // Regeneration stays idempotent and still respects the closure.
    expect(await generate()).toBe(0);
    expect(await sessionDays(ids.clinic)).toHaveLength(3);
  });

  it('records one clinic-scoped audit event and is idempotent on re-add', async () => {
    const schedules = new SchedulingService(pool);
    await schedules.addClosure(scope, MONDAY);
    expect(await schedules.addClosure(scope, MONDAY)).toEqual({
      closureDate: MONDAY,
      created: false,
    });

    const after = await snapshot();
    expect(after.closures).toEqual([
      { clinic_id: ids.clinic, closure_date: MONDAY },
    ]);
    expect(after.audits).toEqual([
      {
        clinic_id: ids.clinic,
        actor_user_id: ids.admin,
        entity_type: 'clinic',
        entity_id: ids.clinic,
        metadata: { closureDate: MONDAY },
      },
    ]);
  });

  it.each([
    ['receptionist', () => ids.receptionist, () => ids.clinic],
    ['doctor', () => ids.doctorUser, () => ids.clinic],
    ['non-member', () => ids.outsider, () => ids.clinic],
    ['admin of another clinic', () => ids.otherAdmin, () => ids.clinic],
  ])('denies a %s and writes nothing', async (_label, actor, clinic) => {
    await expect(
      new SchedulingService(pool).addClosure(
        { clinicId: clinic(), actorUserId: actor() },
        MONDAY,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(await snapshot()).toEqual({ closures: [], audits: [] });
  });

  it.each(['2026-02-29', '2026-13-01', '2026-9-7', '', '0000-01-01'])(
    'rejects the invalid calendar day %j',
    async (day) => {
      await expect(
        new SchedulingService(pool).addClosure(scope, day),
      ).rejects.toBeInstanceOf(TypeError);
      expect(await snapshot()).toEqual({ closures: [], audits: [] });
    },
  );

  it('rejects a closure over a day with non-cancelled sessions without writing', async () => {
    const schedules = new SchedulingService(pool);
    expect(await generate()).toBe(4);

    await expect(schedules.addClosure(scope, MONDAY)).rejects.toBeInstanceOf(
      ClinicClosureConflictError,
    );
    expect(await snapshot()).toEqual({ closures: [], audits: [] });
    expect(await sessionDays(ids.clinic)).toHaveLength(4);
  });

  it('allows a closure once that day only has cancelled sessions', async () => {
    const schedules = new SchedulingService(pool);
    await generate();
    await pool.query(
      `UPDATE consultation_sessions SET status = 'cancelled'
        WHERE clinic_id = $1 AND service_date = $2::date`,
      [ids.clinic, MONDAY],
    );
    expect((await schedules.addClosure(scope, MONDAY)).created).toBe(true);
    // A closure in one clinic never depends on another clinic's sessions.
    expect(await generate(otherScope)).toBe(4);
    // Tuesday still has a planned session, so it stays rejected.
    await expect(schedules.addClosure(scope, TUESDAY)).rejects.toBeInstanceOf(
      ClinicClosureConflictError,
    );
  });

  it('never lets a concurrent closure and generation both commit for one day', async () => {
    const schedules = new SchedulingService(pool);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await pool.query('DELETE FROM clinic_closures');
      await pool.query('DELETE FROM consultation_sessions');
      const [closure, generated] = await Promise.allSettled([
        schedules.addClosure(scope, MONDAY),
        generate(),
      ]);
      expect(generated.status).toBe('fulfilled');
      const closed = (await snapshot()).closures.length === 1;
      const mondaySessions = (await sessionDays(ids.clinic)).filter(
        (day) => day === MONDAY,
      );
      if (closure.status === 'fulfilled') {
        expect(closed).toBe(true);
        expect(mondaySessions).toEqual([]);
      } else {
        expect(closure.reason).toBeInstanceOf(ClinicClosureConflictError);
        expect(closed).toBe(false);
        expect(mondaySessions).toEqual([MONDAY]);
      }
    }
  });

  it('lists closures to clinic staff only, scoped to their clinic', async () => {
    const schedules = new SchedulingService(pool);
    await schedules.addClosure(scope, TUESDAY);
    await schedules.addClosure(scope, MONDAY);
    expect(
      await schedules.listClosures({
        clinicId: ids.clinic,
        actorUserId: ids.receptionist,
      }),
    ).toEqual([MONDAY, TUESDAY]);
    expect(await schedules.listClosures(otherScope)).toEqual([]);
    await expect(
      schedules.listClosures({
        clinicId: ids.clinic,
        actorUserId: ids.outsider,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
