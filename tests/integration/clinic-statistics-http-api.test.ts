import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import * as statistics from '@/app/api/clinics/[clinicId]/statistics/route';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

// TAB-P1-05 slice 3 (#867): a doctor reviews only their OWN operational
// statistics; clinic_admin keeps the clinic-wide view; others stay denied.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ORIGIN = 'http://localhost';
const id = {
  clinic: randomUUID(),
  other: randomUUID(),
  admin: randomUUID(),
  reception: randomUUID(),
  userA: randomUUID(),
  userB: randomUUID(),
  userNoProfile: randomUUID(),
  docA: randomUUID(),
  docB: randomUUID(),
};

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'clinic-statistics-http-test-secret-at-least-32-chars';
  await migrate();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_entries, consultation_sessions,
    schedule_templates, doctor_clinics, doctor_profiles, staff_sessions,
    clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
     ($1,'st-admin','Admin'),($2,'st-rec','Rec'),($3,'st-a','A'),($4,'st-b','B'),($5,'st-np','NP')`,
    [id.admin, id.reception, id.userA, id.userB, id.userNoProfile],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'st-c','C'),($2,'st-o','O')`,
    [id.clinic, id.other],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
     ($1,$2,'clinic_admin'),($1,$3,'receptionist'),($1,$4,'doctor'),($1,$5,'doctor'),($1,$6,'doctor')`,
    [id.clinic, id.admin, id.reception, id.userA, id.userB, id.userNoProfile],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$3,'Dr A'),($2,$4,'Dr B')`,
    [id.docA, id.docB, id.userA, id.userB],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2),($1,$3),($4,$2)`,
    [id.clinic, id.docA, id.docB, id.other],
  );
  // A: one session 09-08 (late 10 min) in this clinic and one in the other clinic.
  // B: one session 09-08 opened on time.
  await pool.query(
    `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status,opened_at) VALUES
     ($1,$4,$5,'2026-09-08','2026-09-08 09:00Z','2026-09-08 12:00Z','closed','2026-09-08 09:10Z'),
     ($2,$4,$6,'2026-09-08','2026-09-08 09:00Z','2026-09-08 12:00Z','closed','2026-09-08 09:00Z'),
     ($3,$7,$5,'2026-09-08','2026-09-08 09:00Z','2026-09-08 12:00Z','closed','2026-09-08 09:30Z')`,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      id.clinic,
      id.docA,
      id.docB,
      id.other,
    ],
  );
});
afterAll(async () => {
  await pool.end();
  await closePool();
});

async function get(subject: string, query = 'from=2026-09-01&to=2026-09-30') {
  const cookie = `tabibi_staff_session=${await createStaffSessionToken(
    subject,
    new Date(Date.now() + 60_000),
  )}`;
  const res = await statistics.GET(
    new Request(`${ORIGIN}/api/clinics/${id.clinic}/statistics?${query}`, {
      headers: { cookie, origin: ORIGIN },
    }),
    { params: Promise.resolve({ clinicId: id.clinic }) },
  );
  return { status: res.status, json: await res.json() };
}

describe('GET /statistics role scoping', () => {
  it('clinic_admin sees every doctor (positive control)', async () => {
    const r = await get('st-admin');
    expect(r.status).toBe(200);
    expect(
      r.json.doctors.map((d: { doctorId: string }) => d.doctorId).sort(),
    ).toEqual([id.docA, id.docB].sort());
    expect(r.json.delayTrend).toEqual([
      { date: '2026-09-08', sessions: 2, opened: 2, lateStarts: 1 },
    ]);
  });

  it('a doctor sees only their own row and trend, ignoring any doctorId parameter', async () => {
    for (const q of [
      'from=2026-09-01&to=2026-09-30',
      `from=2026-09-01&to=2026-09-30&doctorId=${id.docB}`,
    ]) {
      const r = await get('st-b', q);
      expect(r.status).toBe(200);
      expect(r.json.doctors).toHaveLength(1);
      expect(r.json.doctors[0].doctorId).toBe(id.docB);
      expect(r.json.delayTrend).toEqual([
        { date: '2026-09-08', sessions: 1, opened: 1, lateStarts: 0 },
      ]);
    }
    const a = await get('st-a');
    expect(a.json.doctors[0].doctorId).toBe(id.docA);
    // The other clinic's session of the same doctor never counts.
    expect(a.json.doctors[0].sessions).toBe(1);
    expect(a.json.delayTrend).toEqual([
      { date: '2026-09-08', sessions: 1, opened: 1, lateStarts: 1 },
    ]);
  });

  it('denies a receptionist and a doctor membership without a doctor profile', async () => {
    expect((await get('st-rec')).status).toBe(403);
    expect((await get('st-np')).status).toBe(403);
  });
});
