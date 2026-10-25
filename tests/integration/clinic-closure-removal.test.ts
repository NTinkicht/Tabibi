import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AuthorizationError } from '@/modules/identity';
import { SchedulingService } from '@/modules/scheduling';
import { SessionService } from '@/modules/session';

// TAB-P0-02 (#649): a clinic closure day can be removed by that clinic's admin,
// after which the day can be planned again. Removal is clinic-scoped, audited
// once, idempotent and serialized with generation by the clinic calendar lock.
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
  await pool.query(`TRUNCATE audit_events, clinic_closures, session_command_receipts,
    consultation_sessions,
    schedule_templates, doctor_clinics, doctor_profiles, clinic_memberships,
    clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'removal-admin', 'Admin'), ($2, 'removal-other-admin', 'Other Admin'),
       ($3, 'removal-receptionist', 'Receptionist'),
       ($4, 'removal-doctor', 'Doctor'), ($5, 'removal-outsider', 'Outsider')`,
    [ids.admin, ids.otherAdmin, ids.receptionist, ids.doctorUser, ids.outsider],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'removal-clinic', 'Clinic'), ($2, 'removal-other-clinic', 'Other')`,
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
    daysAhead: 7,
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
  const audits = await pool.query(
    `SELECT clinic_id, actor_user_id, entity_type, entity_id, metadata
       FROM audit_events WHERE action = 'clinic_closure.removed' ORDER BY id`,
  );
  return { closures: closures.rows, audits: audits.rows };
}

async function closeBothClinicsOnMonday() {
  const schedules = new SchedulingService(pool);
  await schedules.addClosure(scope, MONDAY);
  await schedules.addClosure(otherScope, MONDAY);
}

describe('clinic closure removal', () => {
  it('removes only this clinic closure and records one audit event', async () => {
    await closeBothClinicsOnMonday();

    expect(
      await new SchedulingService(pool).removeClosure(scope, MONDAY),
    ).toEqual({ closureDate: MONDAY, removed: true });

    expect(await snapshot()).toEqual({
      closures: [{ clinic_id: ids.otherClinic, closure_date: MONDAY }],
      audits: [
        {
          clinic_id: ids.clinic,
          actor_user_id: ids.admin,
          entity_type: 'clinic',
          entity_id: ids.clinic,
          metadata: { closureDate: MONDAY },
        },
      ],
    });
  });

  it('is an idempotent no-op without audit for a day that is not a closure', async () => {
    await closeBothClinicsOnMonday();
    const schedules = new SchedulingService(pool);
    await schedules.removeClosure(scope, MONDAY);

    expect(await schedules.removeClosure(scope, MONDAY)).toEqual({
      closureDate: MONDAY,
      removed: false,
    });
    expect(await schedules.removeClosure(scope, TUESDAY)).toEqual({
      closureDate: TUESDAY,
      removed: false,
    });
    expect((await snapshot()).audits).toHaveLength(1);
  });

  it('lets generation and manual sessions plan the day again', async () => {
    await closeBothClinicsOnMonday();
    expect(await generate()).toBe(1);
    expect(await sessionDays(ids.clinic)).toEqual([TUESDAY]);

    await new SchedulingService(pool).removeClosure(scope, MONDAY);

    expect(await generate()).toBe(1);
    expect(await sessionDays(ids.clinic)).toEqual([MONDAY, TUESDAY]);
    // Regeneration stays idempotent after the removal.
    expect(await generate()).toBe(0);
    // The other clinic keeps its closure.
    expect(await generate(otherScope)).toBe(1);
    expect(await sessionDays(ids.otherClinic)).toEqual([TUESDAY]);
    // A manual session (14:00-16:00 Africa/Algiers) is accepted on that day.
    const manual = await new SessionService(pool).createManual(
      { clinicId: ids.clinic, actorUserId: ids.receptionist },
      {
        doctorId: ids.doctor,
        serviceDate: MONDAY,
        startsAt: new Date(`${MONDAY}T13:00:00Z`),
        endsAt: new Date(`${MONDAY}T15:00:00Z`),
        idempotencyKey: 'manual-after-removal',
        correlationId: 'request-manual-after-removal',
      },
    );
    expect(manual.serviceDate).toBe(MONDAY);
  });

  it.each([
    ['receptionist', () => ids.receptionist],
    ['doctor', () => ids.doctorUser],
    ['non-member', () => ids.outsider],
    ['admin of another clinic', () => ids.otherAdmin],
  ])('denies a %s and changes nothing', async (_label, actor) => {
    await closeBothClinicsOnMonday();
    const before = await snapshot();

    await expect(
      new SchedulingService(pool).removeClosure(
        { clinicId: ids.clinic, actorUserId: actor() },
        MONDAY,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(await snapshot()).toEqual(before);
    expect(before.closures).toHaveLength(2);
  });

  it.each(['2026-02-29', '2026-13-01', '2026-9-7', '', '0000-01-01'])(
    'rejects the invalid calendar day %j',
    async (day) => {
      await closeBothClinicsOnMonday();
      await expect(
        new SchedulingService(pool).removeClosure(scope, day),
      ).rejects.toBeInstanceOf(TypeError);
      expect((await snapshot()).closures).toHaveLength(2);
    },
  );

  it('never leaves a closure and a session on the same day under a concurrent removal and generation', async () => {
    const schedules = new SchedulingService(pool);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await pool.query('DELETE FROM clinic_closures');
      await pool.query('DELETE FROM consultation_sessions');
      await schedules.addClosure(scope, MONDAY);
      const [removal, generated] = await Promise.allSettled([
        schedules.removeClosure(scope, MONDAY),
        generate(),
      ]);
      expect(removal.status).toBe('fulfilled');
      expect(generated.status).toBe('fulfilled');
      expect((await snapshot()).closures).toEqual([]);
      const days = await sessionDays(ids.clinic);
      // Either generation ran first (Monday still closed) or after removal.
      expect([[TUESDAY], [MONDAY, TUESDAY]]).toContainEqual(days);
      // Whatever the order, a follow-up generation fills the reopened day once.
      await generate();
      expect(await sessionDays(ids.clinic)).toEqual([MONDAY, TUESDAY]);
    }
  });
});
