import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AuthorizationError } from '@/modules/identity';
import {
  ScheduleCollisionError,
  ScheduleTemplateNotFoundError,
  SchedulingService,
} from '@/modules/scheduling';

// TAB-P0-02 (#647): a recurring schedule template can be retired and restored.
// Deactivation stops future generation without touching generated sessions;
// reactivation re-runs the doctor collision check.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  otherDoctorUser: randomUUID(),
  otherDoctor: randomUUID(),
  outsider: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.admin };
const otherClinicScope = { clinicId: ids.otherClinic, actorUserId: ids.admin };
const MONDAY = 1;
// 2026-09-07 and 2026-09-14 are Mondays.
const FIRST_MONDAY = '2026-09-07';
const SECOND_MONDAY = '2026-09-14';

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'activation-admin', 'Admin'),
       ($2, 'activation-receptionist', 'Receptionist'),
       ($3, 'activation-doctor', 'Doctor'),
       ($4, 'activation-other-doctor', 'Other Doctor'),
       ($5, 'activation-outsider', 'Outsider')`,
    [
      ids.admin,
      ids.receptionist,
      ids.doctorUser,
      ids.otherDoctorUser,
      ids.outsider,
    ],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'activation-clinic', 'Clinic'),
       ($2, 'activation-other-clinic', 'Other Clinic')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $2, 'clinic_admin'), ($1, $3, 'receptionist'),
       ($1, $4, 'doctor'), ($1, $5, 'doctor'), ($6, $2, 'clinic_admin')`,
    [
      ids.clinic,
      ids.admin,
      ids.receptionist,
      ids.doctorUser,
      ids.otherDoctorUser,
      ids.otherClinic,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
       ($1, $2, 'Doctor'), ($3, $4, 'Other Doctor')`,
    [ids.doctor, ids.doctorUser, ids.otherDoctor, ids.otherDoctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES
       ($1, $2), ($1, $3), ($4, $2)`,
    [ids.clinic, ids.doctor, ids.otherDoctor, ids.otherClinic],
  );
});

afterAll(async () => pool.end());

function template(
  localStartTime: string,
  localEndTime: string,
  occurrenceIndex: number,
  active = true,
) {
  return {
    doctorId: ids.doctor,
    weekday: MONDAY,
    localStartTime,
    localEndTime,
    occurrenceIndex,
    active,
  };
}

async function state() {
  const templates = await pool.query<{ id: string; active: boolean }>(
    'SELECT id, active FROM schedule_templates ORDER BY id',
  );
  const audits = await pool.query<{ action: string; entity_id: string }>(
    `SELECT action, entity_id::text FROM audit_events
      WHERE action IN ('schedule_template.activated', 'schedule_template.deactivated')
      ORDER BY id`,
  );
  return { templates: templates.rows, audits: audits.rows };
}

async function sessionDates() {
  const result = await pool.query<{ service_date: string }>(
    `SELECT service_date::text FROM consultation_sessions ORDER BY service_date`,
  );
  return result.rows.map((row) => row.service_date);
}

describe('schedule template activation', () => {
  it('deactivates once with one audit event and is idempotent afterwards', async () => {
    const schedules = new SchedulingService(pool);
    const created = await schedules.createTemplate(
      scope,
      template('09:00', '12:00', 0),
    );

    const first = await schedules.setTemplateActive(scope, {
      templateId: created.id,
      active: false,
    });
    expect(first).toEqual({ ...created, active: false });
    const second = await schedules.setTemplateActive(scope, {
      templateId: created.id,
      active: false,
    });
    expect(second).toEqual(first);

    expect(await state()).toEqual({
      templates: [{ id: created.id, active: false }],
      audits: [
        { action: 'schedule_template.deactivated', entity_id: created.id },
      ],
    });
  });

  it('stops later generation without touching generated sessions and resumes on reactivation', async () => {
    const schedules = new SchedulingService(pool);
    const created = await schedules.createTemplate(
      scope,
      template('09:00', '12:00', 0),
    );
    expect(
      await schedules.generateSessions(scope, {
        doctorId: ids.doctor,
        startDate: FIRST_MONDAY,
      }),
    ).toBe(1);

    await schedules.setTemplateActive(scope, {
      templateId: created.id,
      active: false,
    });
    expect(await sessionDates()).toEqual([FIRST_MONDAY]);
    expect(
      await schedules.generateSessions(scope, {
        doctorId: ids.doctor,
        startDate: SECOND_MONDAY,
      }),
    ).toBe(0);
    expect(await sessionDates()).toEqual([FIRST_MONDAY]);

    await schedules.setTemplateActive(scope, {
      templateId: created.id,
      active: true,
    });
    expect(
      await schedules.generateSessions(scope, {
        doctorId: ids.doctor,
        startDate: FIRST_MONDAY,
        daysAhead: 14,
      }),
    ).toBe(1);
    expect(await sessionDates()).toEqual([FIRST_MONDAY, SECOND_MONDAY]);
    expect((await state()).audits.map((audit) => audit.action)).toEqual([
      'schedule_template.deactivated',
      'schedule_template.activated',
    ]);
  });

  it('rejects reactivation that would overlap another active template, without change or audit', async () => {
    const schedules = new SchedulingService(pool);
    const retired = await schedules.createTemplate(
      scope,
      template('09:00', '12:00', 0, false),
    );
    await schedules.createTemplate(scope, template('11:00', '14:00', 1));
    const before = await state();

    await expect(
      schedules.setTemplateActive(scope, {
        templateId: retired.id,
        active: true,
      }),
    ).rejects.toBeInstanceOf(ScheduleCollisionError);
    expect(await state()).toEqual(before);
  });

  it('allows reactivation next to an adjacent active template', async () => {
    const schedules = new SchedulingService(pool);
    const retired = await schedules.createTemplate(
      scope,
      template('09:00', '12:00', 0, false),
    );
    await schedules.createTemplate(scope, template('12:00', '15:00', 1));
    const restored = await schedules.setTemplateActive(scope, {
      templateId: retired.id,
      active: true,
    });
    expect(restored.active).toBe(true);
  });

  it('lets exactly one of two concurrent overlapping reactivations commit', async () => {
    const schedules = new SchedulingService(pool);
    const a = await schedules.createTemplate(
      scope,
      template('09:00', '12:00', 0, false),
    );
    const b = await schedules.createTemplate(
      scope,
      template('10:00', '13:00', 1, false),
    );
    const results = await Promise.allSettled([
      schedules.setTemplateActive(scope, { templateId: a.id, active: true }),
      schedules.setTemplateActive(scope, { templateId: b.id, active: true }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ScheduleCollisionError);
    const after = await state();
    expect(after.templates.filter((t) => t.active)).toHaveLength(1);
    expect(after.audits).toHaveLength(1);
  });

  it('lets the template doctor change their own template', async () => {
    const schedules = new SchedulingService(pool);
    const created = await schedules.createTemplate(
      scope,
      template('09:00', '12:00', 0),
    );
    const doctorScope = { clinicId: ids.clinic, actorUserId: ids.doctorUser };
    const changed = await schedules.setTemplateActive(doctorScope, {
      templateId: created.id,
      active: false,
    });
    expect(changed.active).toBe(false);
  });

  it.each([
    ['a receptionist', 'receptionist'],
    ['another doctor of the clinic', 'otherDoctorUser'],
    ['a non-member', 'outsider'],
  ] as const)('denies %s without change or audit', async (_label, actor) => {
    const schedules = new SchedulingService(pool);
    const created = await schedules.createTemplate(
      scope,
      template('09:00', '12:00', 0),
    );
    const before = await state();
    await expect(
      schedules.setTemplateActive(
        { clinicId: ids.clinic, actorUserId: ids[actor] },
        { templateId: created.id, active: false },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(await state()).toEqual(before);
  });

  it('denies a non-member before the lookup, even for an unknown template id', async () => {
    const schedules = new SchedulingService(pool);
    await expect(
      schedules.setTemplateActive(
        { clinicId: ids.clinic, actorUserId: ids.outsider },
        { templateId: randomUUID(), active: false },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('reports another clinic template exactly like an unknown id, without change or audit', async () => {
    const schedules = new SchedulingService(pool);
    const foreign = await schedules.createTemplate(
      otherClinicScope,
      template('09:00', '12:00', 0),
    );
    const before = await state();

    const errors = await Promise.all(
      [foreign.id, randomUUID(), 'not-a-uuid'].map((templateId) =>
        schedules.setTemplateActive(scope, { templateId, active: false }).then(
          () => null,
          (error: unknown) => error,
        ),
      ),
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(ScheduleTemplateNotFoundError);
      expect((error as Error).message).toBe('Schedule template not found');
    }
    expect(await state()).toEqual(before);
  });

  it('rejects a non-boolean active value before any database access', async () => {
    const schedules = new SchedulingService(pool);
    await expect(
      schedules.setTemplateActive(scope, {
        templateId: randomUUID(),
        active: 'false' as unknown as boolean,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
