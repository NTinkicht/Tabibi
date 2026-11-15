import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ClinicStatisticsRepository,
  MIN_COHORT_FOR_AVERAGE,
  StatisticsWindowError,
} from '@/modules/clinic-statistics';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const id = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  userBusy: randomUUID(),
  userQuiet: randomUUID(),
  busy: randomUUID(),
  quiet: randomUUID(),
  busySession: randomUUID(),
  busyOtherClinic: randomUUID(),
  busyOutside: randomUUID(),
  quietSession: randomUUID(),
};
let order = 0;

async function entry(
  clinicId: string,
  sessionId: string,
  state: string,
  seconds?: number,
): Promise<void> {
  const patient = randomUUID();
  order += 1;
  await pool.query(
    `INSERT INTO patient_operational_records
       (id,clinic_id,private_display_name,preferred_locale)
     VALUES($1,$2,'Stat patient','fr')`,
    [patient, clinicId],
  );
  await pool.query(
    `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,
        public_display_label,in_consultation_started_at,completed_at)
     VALUES($1,$2,$3,$4,$5,'walk_in',$6,$7,
       CASE WHEN $8::int IS NULL THEN NULL ELSE '2026-09-08 09:00Z'::timestamptz END,
       CASE WHEN $8::int IS NULL THEN NULL
            ELSE '2026-09-08 09:00Z'::timestamptz + make_interval(secs => $8::int) END)`,
    [
      randomUUID(),
      clinicId,
      sessionId,
      patient,
      state,
      order,
      `ST-${order}`,
      seconds ?? null,
    ],
  );
}

beforeAll(async () => migrate());
beforeEach(async () => {
  order = 0;
  await pool.query(`TRUNCATE audit_events, queue_entries, patient_operational_records,
    consultation_sessions, schedule_templates, doctor_clinics, doctor_profiles,
    clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'stat-busy','B'),($2,'stat-quiet','Q')`,
    [id.userBusy, id.userQuiet],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'stat-a','A'),($2,'stat-b','B')`,
    [id.clinicA, id.clinicB],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$3,'Dr Busy'),($2,$4,'Dr Quiet')`,
    [id.busy, id.quiet, id.userBusy, id.userQuiet],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$3),($2,$3),($1,$4)`,
    [id.clinicA, id.clinicB, id.busy, id.quiet],
  );
  await pool.query(
    `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status) VALUES
     ($1,$5,$7,'2026-09-08','2026-09-08 09:00Z','2026-09-08 12:00Z','closed'),
     ($2,$6,$7,'2026-09-08','2026-09-08 13:00Z','2026-09-08 16:00Z','closed'),
     ($3,$5,$7,'2026-10-20','2026-10-20 09:00Z','2026-10-20 12:00Z','closed'),
     ($4,$5,$8,'2026-09-09','2026-09-09 09:00Z','2026-09-09 12:00Z','closed')`,
    [
      id.busySession,
      id.busyOtherClinic,
      id.busyOutside,
      id.quietSession,
      id.clinicA,
      id.clinicB,
      id.busy,
      id.quiet,
    ],
  );
});
afterAll(async () => pool.end());

describe('clinic operational statistics', () => {
  it('counts per doctor inside the window, scoped to the clinic, with a small-cohort average rule', async () => {
    for (const s of [600, 600, 600, 600, 900])
      await entry(id.clinicA, id.busySession, 'completed', s);
    await entry(id.clinicA, id.busySession, 'no_show');
    await entry(id.clinicA, id.busySession, 'cancelled');
    // Other clinic and out-of-window sessions of the same doctor must not leak in.
    for (let i = 0; i < 6; i += 1) {
      await entry(id.clinicB, id.busyOtherClinic, 'completed', 60);
      await entry(id.clinicA, id.busyOutside, 'completed', 60);
    }
    await entry(id.clinicA, id.quietSession, 'completed', 300);
    await entry(id.clinicA, id.quietSession, 'completed', 500);

    const stats = await new ClinicStatisticsRepository(pool).forWindow({
      clinicId: id.clinicA,
      from: '2026-09-01',
      to: '2026-09-30',
    });

    expect(stats.doctors).toEqual([
      {
        doctorId: id.busy,
        doctorName: 'Dr Busy',
        sessions: 1,
        completed: 5,
        noShow: 1,
        cancelled: 1,
        averageConsultationSeconds: 660,
      },
      {
        doctorId: id.quiet,
        doctorName: 'Dr Quiet',
        sessions: 1,
        completed: 2,
        noShow: 0,
        cancelled: 0,
        // 2 < MIN_COHORT_FOR_AVERAGE: withheld rather than exposing near-individual values.
        averageConsultationSeconds: null,
      },
    ]);
    expect(MIN_COHORT_FOR_AVERAGE).toBe(5);
    // Positive control: moving the window onto the October session reports it.
    const wide = await new ClinicStatisticsRepository(pool).forWindow({
      clinicId: id.clinicA,
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(wide.doctors.find((d) => d.doctorId === id.busy)?.sessions).toBe(1);
    expect(wide.doctors.find((d) => d.doctorId === id.busy)?.completed).toBe(6);
  });

  it('rejects malformed, reversed and oversized windows', async () => {
    const repo = new ClinicStatisticsRepository(pool);
    for (const [from, to] of [
      ['2026-02-30', '2026-03-01'],
      ['2026-09-10', '2026-09-01'],
      ['2026-09-01', '2026-10-02'],
      ['09/01/2026', '2026-09-02'],
    ])
      await expect(
        repo.forWindow({ clinicId: id.clinicA, from, to }),
      ).rejects.toBeInstanceOf(StatisticsWindowError);
    await expect(
      repo.forWindow({
        clinicId: id.clinicA,
        from: '2026-09-01',
        to: '2026-10-01',
      }),
    ).resolves.toBeDefined();
  });
});
