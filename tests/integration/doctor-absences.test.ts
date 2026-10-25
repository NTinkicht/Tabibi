import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AuthorizationError } from '@/modules/identity';
import {
  DoctorAbsenceConflictError,
  SchedulingService,
} from '@/modules/scheduling';
import { SessionConflictError, SessionService } from '@/modules/session';

// TAB-P0-02 (#655): per-doctor absence days. Generation plans nothing for that
// doctor in that clinic on an absence day, manual sessions are rejected, other
// doctors and other clinics are unaffected, and an absence never coexists with
// a non-cancelled session of that doctor in that clinic on that day.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  otherAdmin: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  colleagueUser: randomUUID(),
  strangerUser: randomUUID(),
  outsider: randomUUID(),
  doctor: randomUUID(),
  colleague: randomUUID(),
  stranger: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.admin };
const otherScope = { clinicId: ids.otherClinic, actorUserId: ids.otherAdmin };
const MONDAY = '2026-09-07';
const TUESDAY = '2026-09-08';

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, doctor_absences, clinic_closures,
    session_command_receipts, consultation_sessions,
    schedule_templates, doctor_clinics, doctor_profiles, clinic_memberships,
    clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'absence-admin', 'Admin'), ($2, 'absence-other-admin', 'Other Admin'),
       ($3, 'absence-receptionist', 'Receptionist'),
       ($4, 'absence-doctor', 'Doctor'), ($5, 'absence-colleague', 'Colleague'),
       ($6, 'absence-stranger', 'Stranger'), ($7, 'absence-outsider', 'Outsider')`,
    [
      ids.admin,
      ids.otherAdmin,
      ids.receptionist,
      ids.doctorUser,
      ids.colleagueUser,
      ids.strangerUser,
      ids.outsider,
    ],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'absence-clinic', 'Clinic'), ($2, 'absence-other-clinic', 'Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($1, $4, 'receptionist'), ($1, $5, 'doctor'),
       ($1, $6, 'doctor'), ($2, $7, 'clinic_admin'), ($2, $5, 'doctor'),
       ($2, $8, 'doctor')`,
    [
      ids.clinic,
      ids.otherClinic,
      ids.admin,
      ids.receptionist,
      ids.doctorUser,
      ids.colleagueUser,
      ids.otherAdmin,
      ids.strangerUser,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
       ($1, $2, 'Doctor'), ($3, $4, 'Colleague'), ($5, $6, 'Stranger')`,
    [
      ids.doctor,
      ids.doctorUser,
      ids.colleague,
      ids.colleagueUser,
      ids.stranger,
      ids.strangerUser,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES
       ($1, $3), ($1, $4), ($2, $3), ($2, $5)`,
    [ids.clinic, ids.otherClinic, ids.doctor, ids.colleague, ids.stranger],
  );
  const schedules = new SchedulingService(pool);
  for (const [s, doctorId] of [
    [scope, ids.doctor],
    [scope, ids.colleague],
    [otherScope, ids.doctor],
  ] as const) {
    for (const weekday of [1, 2]) {
      await schedules.createTemplate(s, {
        doctorId,
        weekday,
        localStartTime: '09:00',
        localEndTime: '12:00',
        occurrenceIndex: 0,
      });
    }
  }
});

afterAll(async () => pool.end());

function generate(s = scope, doctorId = ids.doctor) {
  return new SchedulingService(pool).generateSessions(s, {
    doctorId,
    startDate: MONDAY,
    daysAhead: 14,
  });
}

function absent(s = scope, absenceDate = MONDAY, doctorId = ids.doctor) {
  return new SchedulingService(pool).addDoctorAbsence(s, {
    doctorId,
    absenceDate,
  });
}

async function sessionDays(
  clinicId: string,
  doctorId = ids.doctor,
): Promise<string[]> {
  const result = await pool.query<{ service_date: string }>(
    `SELECT service_date::text FROM consultation_sessions
      WHERE clinic_id = $1 AND doctor_id = $2 AND status <> 'cancelled'
      ORDER BY service_date`,
    [clinicId, doctorId],
  );
  return result.rows.map((row) => row.service_date);
}

async function snapshot() {
  const absences = await pool.query(
    `SELECT clinic_id, doctor_id, absence_date::text
       FROM doctor_absences ORDER BY 1, 2, 3`,
  );
  const audits = await pool.query(
    `SELECT clinic_id, actor_user_id, entity_type, entity_id, action, metadata
       FROM audit_events WHERE action LIKE 'doctor_absence.%' ORDER BY id`,
  );
  return { absences: absences.rows, audits: audits.rows };
}

const EMPTY = { absences: [], audits: [] };

describe('doctor absence days', () => {
  it('skips only that doctor in that clinic during generation', async () => {
    expect(await absent()).toEqual({
      doctorId: ids.doctor,
      absenceDate: MONDAY,
      created: true,
    });

    expect(await generate()).toBe(3);
    expect(await sessionDays(ids.clinic)).toEqual([
      TUESDAY,
      '2026-09-14',
      '2026-09-15',
    ]);
    // A colleague in the same clinic and the same doctor in another clinic
    // keep their Monday.
    expect(await generate(scope, ids.colleague)).toBe(4);
    expect(await sessionDays(ids.clinic, ids.colleague)).toContain(MONDAY);
    expect(await generate(otherScope)).toBe(4);
    expect(await sessionDays(ids.otherClinic)).toContain(MONDAY);
    // Regeneration stays idempotent and still respects the absence.
    expect(await generate()).toBe(0);
    expect(await sessionDays(ids.clinic)).toHaveLength(3);
  });

  it('records one audit event, is idempotent on re-add and lets the doctor mark their own day', async () => {
    await absent();
    expect((await absent()).created).toBe(false);
    const own = { clinicId: ids.clinic, actorUserId: ids.doctorUser };
    expect((await absent(own, TUESDAY)).created).toBe(true);

    expect(await snapshot()).toEqual({
      absences: [
        { clinic_id: ids.clinic, doctor_id: ids.doctor, absence_date: MONDAY },
        { clinic_id: ids.clinic, doctor_id: ids.doctor, absence_date: TUESDAY },
      ],
      audits: [
        {
          clinic_id: ids.clinic,
          actor_user_id: ids.admin,
          entity_type: 'doctor',
          entity_id: ids.doctor,
          action: 'doctor_absence.created',
          metadata: { doctorId: ids.doctor, absenceDate: MONDAY },
        },
        {
          clinic_id: ids.clinic,
          actor_user_id: ids.doctorUser,
          entity_type: 'doctor',
          entity_id: ids.doctor,
          action: 'doctor_absence.created',
          metadata: { doctorId: ids.doctor, absenceDate: TUESDAY },
        },
      ],
    });
  });

  it.each([
    ['receptionist', () => ids.receptionist, () => ids.doctor],
    ['colleague doctor', () => ids.colleagueUser, () => ids.doctor],
    ['non-member', () => ids.outsider, () => ids.doctor],
    ['admin of another clinic', () => ids.otherAdmin, () => ids.doctor],
    [
      'admin, for a doctor of another clinic',
      () => ids.admin,
      () => ids.stranger,
    ],
    ['admin, for an unknown doctor id', () => ids.admin, () => randomUUID()],
    ['admin, for a malformed doctor id', () => ids.admin, () => 'not-a-uuid'],
  ])('denies a %s and writes nothing', async (_label, actor, doctor) => {
    const s = { clinicId: ids.clinic, actorUserId: actor() };
    const schedules = new SchedulingService(pool);
    const input = { doctorId: doctor(), absenceDate: MONDAY };
    await expect(schedules.addDoctorAbsence(s, input)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      schedules.removeDoctorAbsence(s, input),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(await snapshot()).toEqual(EMPTY);
  });

  it.each(['2026-02-29', '2026-13-01', '2026-9-7', '', '0000-01-01'])(
    'rejects the invalid calendar day %j',
    async (day) => {
      await expect(absent(scope, day)).rejects.toBeInstanceOf(TypeError);
      await expect(
        new SchedulingService(pool).removeDoctorAbsence(scope, {
          doctorId: ids.doctor,
          absenceDate: day,
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(await snapshot()).toEqual(EMPTY);
    },
  );

  it("rejects an absence over that doctor's non-cancelled session only", async () => {
    await generate();
    await generate(scope, ids.colleague);
    await expect(absent()).rejects.toBeInstanceOf(DoctorAbsenceConflictError);
    expect(await snapshot()).toEqual(EMPTY);
    expect(await sessionDays(ids.clinic)).toHaveLength(4);

    await pool.query(
      `UPDATE consultation_sessions SET status = 'cancelled'
        WHERE clinic_id = $1 AND doctor_id = $2 AND service_date = $3::date`,
      [ids.clinic, ids.doctor, MONDAY],
    );
    // The colleague's planned Monday never blocks this doctor's absence.
    expect((await absent()).created).toBe(true);
    expect(await sessionDays(ids.clinic, ids.colleague)).toContain(MONDAY);
  });

  it('never lets a concurrent absence and generation both commit for one day', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await pool.query('DELETE FROM doctor_absences');
      await pool.query('DELETE FROM consultation_sessions');
      const [absence, generated] = await Promise.allSettled([
        absent(),
        generate(),
      ]);
      expect(generated.status).toBe('fulfilled');
      const recorded = (await snapshot()).absences.length === 1;
      const monday = (await sessionDays(ids.clinic)).filter(
        (day) => day === MONDAY,
      );
      if (absence.status === 'fulfilled') {
        expect(recorded).toBe(true);
        expect(monday).toEqual([]);
      } else {
        expect(absence.reason).toBeInstanceOf(DoctorAbsenceConflictError);
        expect(recorded).toBe(false);
        expect(monday).toEqual([MONDAY]);
      }
    }
  });

  function createManual(
    serviceDate: string,
    key: string,
    doctorId = ids.doctor,
  ) {
    // 14:00-16:00 Africa/Algiers (UTC+1), clear of the 09:00-12:00 templates.
    return new SessionService(pool).createManual(
      { clinicId: ids.clinic, actorUserId: ids.receptionist },
      {
        doctorId,
        serviceDate,
        startsAt: new Date(`${serviceDate}T13:00:00Z`),
        endsAt: new Date(`${serviceDate}T15:00:00Z`),
        idempotencyKey: key,
        correlationId: `request-${key}`,
      },
    );
  }

  it('rejects a manual session on an absence day and writes nothing', async () => {
    await absent();
    const audits = await pool.query(
      'SELECT count(*)::int AS n FROM audit_events',
    );

    await expect(createManual(MONDAY, 'manual-absent')).rejects.toBeInstanceOf(
      SessionConflictError,
    );
    expect(await sessionDays(ids.clinic)).toEqual([]);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM audit_events')).rows,
    ).toEqual(audits.rows);
    // Another day of this doctor, and a colleague on the same day, stay open.
    expect((await createManual(TUESDAY, 'manual-open')).serviceDate).toBe(
      TUESDAY,
    );
    expect(
      (await createManual(MONDAY, 'manual-colleague', ids.colleague))
        .serviceDate,
    ).toBe(MONDAY);
  });

  it('removes only that absence, audits once and lets generation plan the day again', async () => {
    const schedules = new SchedulingService(pool);
    await absent();
    await absent(otherScope);
    await absent(scope, MONDAY, ids.colleague);
    const input = { doctorId: ids.doctor, absenceDate: MONDAY };

    expect(await schedules.removeDoctorAbsence(scope, input)).toEqual({
      ...input,
      removed: true,
    });
    expect((await schedules.removeDoctorAbsence(scope, input)).removed).toBe(
      false,
    );
    const after = await snapshot();
    expect(after.absences).toEqual(
      [
        {
          clinic_id: ids.clinic,
          doctor_id: ids.colleague,
          absence_date: MONDAY,
        },
        {
          clinic_id: ids.otherClinic,
          doctor_id: ids.doctor,
          absence_date: MONDAY,
        },
      ].sort((a, b) =>
        `${a.clinic_id}${a.doctor_id}` < `${b.clinic_id}${b.doctor_id}`
          ? -1
          : 1,
      ),
    );
    expect(
      after.audits.filter((row) => row.action === 'doctor_absence.removed'),
    ).toEqual([
      {
        clinic_id: ids.clinic,
        actor_user_id: ids.admin,
        entity_type: 'doctor',
        entity_id: ids.doctor,
        action: 'doctor_absence.removed',
        metadata: { doctorId: ids.doctor, absenceDate: MONDAY },
      },
    ]);
    expect(await generate()).toBe(4);
    expect(await sessionDays(ids.clinic)).toContain(MONDAY);
  });

  it('lists absences to clinic staff only, scoped to clinic and doctor', async () => {
    const schedules = new SchedulingService(pool);
    await absent(scope, TUESDAY);
    await absent(scope, MONDAY);
    await absent(otherScope, '2026-09-14');
    expect(
      await schedules.listDoctorAbsences(
        { clinicId: ids.clinic, actorUserId: ids.receptionist },
        ids.doctor,
      ),
    ).toEqual([MONDAY, TUESDAY]);
    expect(await schedules.listDoctorAbsences(scope, ids.colleague)).toEqual(
      [],
    );
    expect(await schedules.listDoctorAbsences(otherScope, ids.doctor)).toEqual([
      '2026-09-14',
    ]);
    await expect(
      schedules.listDoctorAbsences(
        { clinicId: ids.clinic, actorUserId: ids.outsider },
        ids.doctor,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    for (const doctorId of [ids.stranger, randomUUID(), 'not-a-uuid']) {
      await expect(
        schedules.listDoctorAbsences(scope, doctorId),
      ).rejects.toBeInstanceOf(AuthorizationError);
    }
  });

  it('drops the absences when the doctor leaves the clinic', async () => {
    await absent();
    await absent(otherScope);
    await pool.query(
      'DELETE FROM doctor_clinics WHERE clinic_id = $1 AND doctor_id = $2',
      [ids.clinic, ids.doctor],
    );
    expect((await snapshot()).absences).toEqual([
      {
        clinic_id: ids.otherClinic,
        doctor_id: ids.doctor,
        absence_date: MONDAY,
      },
    ]);
  });
});
