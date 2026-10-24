import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  ScheduleCollisionError,
  SchedulingService,
} from '@/modules/scheduling';

// TAB-P0-02 (#636): schedule-level doctor collision validation. Two active
// weekly templates of one doctor in one clinic must not overlap on the same
// weekday, otherwise generation plans overlapping sessions every week.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const ids = {
  clinic: randomUUID(),
  admin: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  otherDoctorUser: randomUUID(),
  otherDoctor: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.admin };
const MONDAY = 1;

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'collision-admin', 'Admin'),
       ($2, 'collision-doctor', 'Doctor'),
       ($3, 'collision-other-doctor', 'Other Doctor')`,
    [ids.admin, ids.doctorUser, ids.otherDoctorUser],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'collision-clinic', 'Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $2, 'clinic_admin'), ($1, $3, 'doctor'), ($1, $4, 'doctor')`,
    [ids.clinic, ids.admin, ids.doctorUser, ids.otherDoctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
       ($1, $2, 'Doctor'), ($3, $4, 'Other Doctor')`,
    [ids.doctor, ids.doctorUser, ids.otherDoctor, ids.otherDoctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2), ($1, $3)`,
    [ids.clinic, ids.doctor, ids.otherDoctor],
  );
});

afterAll(async () => pool.end());

function template(
  localStartTime: string,
  localEndTime: string,
  occurrenceIndex: number,
  overrides: { weekday?: number; doctorId?: string; active?: boolean } = {},
) {
  return {
    doctorId: overrides.doctorId ?? ids.doctor,
    weekday: overrides.weekday ?? MONDAY,
    localStartTime,
    localEndTime,
    occurrenceIndex,
    ...(overrides.active === undefined ? {} : { active: overrides.active }),
  };
}

async function snapshot() {
  const templates = await pool.query<{ id: string }>(
    'SELECT id FROM schedule_templates ORDER BY id',
  );
  const audits = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE action = 'schedule_template.created'`,
  );
  return {
    templates: templates.rows.map((row) => row.id),
    audits: Number(audits.rows[0]?.count),
  };
}

describe('schedule template doctor collision validation', () => {
  it.each([
    ['identical', '09:00', '12:00'],
    ['contained', '10:00', '11:00'],
    ['containing', '08:00', '13:00'],
    ['overlapping the start', '08:00', '09:30'],
    ['overlapping the end', '11:59', '14:00'],
  ])(
    'rejects a %s range on the same weekday without writing a template or audit event',
    async (_label, start, end) => {
      const schedules = new SchedulingService(pool);
      await schedules.createTemplate(scope, template('09:00', '12:00', 0));
      const before = await snapshot();

      await expect(
        schedules.createTemplate(scope, template(start, end, 1)),
      ).rejects.toBeInstanceOf(ScheduleCollisionError);

      expect(await snapshot()).toEqual(before);
      expect(before.templates).toHaveLength(1);
      expect(before.audits).toBe(1);
    },
  );

  it('allows adjacent ranges, other weekdays and other doctors', async () => {
    const schedules = new SchedulingService(pool);
    await schedules.createTemplate(scope, template('09:00', '12:00', 0));
    await schedules.createTemplate(scope, template('12:00', '15:00', 1));
    await schedules.createTemplate(scope, template('07:00', '09:00', 2));
    await schedules.createTemplate(
      scope,
      template('09:00', '12:00', 0, { weekday: MONDAY + 1 }),
    );
    await schedules.createTemplate(
      scope,
      template('09:00', '12:00', 0, { doctorId: ids.otherDoctor }),
    );
    expect((await snapshot()).templates).toHaveLength(5);
  });

  it('ignores inactive templates on either side of the comparison', async () => {
    const schedules = new SchedulingService(pool);
    await schedules.createTemplate(
      scope,
      template('09:00', '12:00', 0, { active: false }),
    );
    await schedules.createTemplate(scope, template('10:00', '13:00', 1));
    await schedules.createTemplate(
      scope,
      template('10:00', '11:00', 2, { active: false }),
    );
    expect((await snapshot()).templates).toHaveLength(3);
  });

  it('lets exactly one of two concurrent overlapping creates commit', async () => {
    const schedules = new SchedulingService(pool);
    const results = await Promise.allSettled([
      schedules.createTemplate(scope, template('09:00', '12:00', 0)),
      schedules.createTemplate(scope, template('10:00', '13:00', 1)),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ScheduleCollisionError);
    const after = await snapshot();
    expect(after.templates).toHaveLength(1);
    expect(after.audits).toBe(1);
  });

  it('never generates overlapping planned sessions after a rejected collision', async () => {
    const schedules = new SchedulingService(pool);
    await schedules.createTemplate(scope, template('09:00', '12:00', 0));
    await expect(
      schedules.createTemplate(scope, template('11:00', '14:00', 1)),
    ).rejects.toBeInstanceOf(ScheduleCollisionError);

    expect(
      await schedules.generateSessions(scope, {
        doctorId: ids.doctor,
        startDate: '2026-09-07',
      }),
    ).toBe(1);
    const overlaps = await pool.query(
      `SELECT 1 FROM consultation_sessions a
         JOIN consultation_sessions b
           ON a.doctor_id = b.doctor_id AND a.id < b.id
          AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at`,
    );
    expect(overlaps.rowCount).toBe(0);
  });
});
