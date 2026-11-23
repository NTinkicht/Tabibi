import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { POST as reschedulePost } from '@/app/api/patient/visits/[appointmentId]/reschedule/route';
import { GET as optionsGet } from '@/app/api/patient/visits/[appointmentId]/reschedule-options/route';
import { POST as cancelPost } from '@/app/api/patient/visits/[appointmentId]/cancel/route';
import { POST as signInPost } from '@/app/api/patient/session/route';
import {
  PatientVisitRescheduleConflictError,
  PatientVisitRescheduleService,
} from '@/modules/patient-visit-history/reschedule';
import { registerPatientAccount } from '@/modules/identity/patient-credentials';
import { closePool, getPool } from '@/platform/database/pool';

// TAB-P1-04 slice 7: valid reschedule targets for a patient's upcoming visit.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const SECRET = 'patient-visit-resched-secret-at-least-32-chars';
const PASS = 'correct horse battery';
const A = 'leila.resched@example.test';
const B = 'karim.resched@example.test';
const URL_BASE = 'http://localhost/api/patient/visits';
const clinic: string = randomUUID();
const otherClinic: string = randomUUID();
const doctor: string = randomUUID();
let seq = 0;

const login = async (email: string) => {
  const res = await signInPost(
    new Request('http://localhost/api/patient/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ email, password: PASS }),
    }),
  );
  return `tabibi_patient_session=${/tabibi_patient_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]}`;
};
const reschedule = (
  cookie: string | null,
  id: string,
  target: unknown,
  origin: string | null = 'http://localhost',
) =>
  reschedulePost(
    new Request(`${URL_BASE}/${id}/reschedule`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({ targetSessionId: target }),
    }),
    { params: Promise.resolve({ appointmentId: id }) },
  );
const options = (cookie: string | null, id: string) =>
  optionsGet(
    new Request(`${URL_BASE}/${id}/reschedule-options`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ appointmentId: id }) },
  );
const cancel = (cookie: string, id: string) =>
  cancelPost(
    new Request(`${URL_BASE}/${id}/cancel`, {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost' },
    }),
    { params: Promise.resolve({ appointmentId: id }) },
  );
/** Plants one extra session for the shared doctor and returns its id. */
async function seedSession(
  startsAt: Date,
  opts: { status?: string; doctorId?: string; clinicId?: string } = {},
): Promise<string> {
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,$4::date,$5,$6,$7::session_status)`,
    [
      sessionId,
      opts.clinicId ?? clinic,
      opts.doctorId ?? doctor,
      startsAt.toISOString().slice(0, 10),
      startsAt,
      new Date(startsAt.getTime() + 15 * 60_000),
      opts.status ?? 'planned',
    ],
  );
  return sessionId;
}
const userIds = new Map<string, string>();
const userId = async (email: string) => userIds.get(email)!;

/** Seeds one appointment (own record, optionally for a dependent) at `startsAt`. */
async function seedVisit(
  accountUserId: string | null,
  startsAt: Date,
  status = 'booked',
  dependentId: string | null = null,
  queueState = 'waiting',
): Promise<string> {
  seq += 1;
  const sessionId = randomUUID();
  const patientId = randomUUID();
  const entryId = randomUUID();
  const appointmentId = randomUUID();
  const end = new Date(startsAt.getTime() + 15 * 60_000);
  await pool.query(
    `INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,$4::date,$5,$6,'planned')`,
    [
      sessionId,
      clinic,
      doctor,
      startsAt.toISOString().slice(0, 10),
      startsAt,
      end,
    ],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
       (id,clinic_id,account_user_id,private_display_name,preferred_locale)
     VALUES($1,$2,$3,'Private Name','fr')`,
    [patientId, clinic, accountUserId],
  );
  await pool.query(
    `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
     VALUES($1,$2,$3,$4,$5::queue_entry_status,'appointment',1,$6)`,
    [entryId, clinic, sessionId, patientId, queueState, `V-${seq}`],
  );
  await pool.query(
    `INSERT INTO appointments
       (id,clinic_id,doctor_id,session_id,patient_id,queue_entry_id,status,
        scheduled_start_at,scheduled_end_at,preferred_locale,dependent_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'fr',$10)`,
    [
      appointmentId,
      clinic,
      doctor,
      sessionId,
      patientId,
      entryId,
      status,
      startsAt,
      end,
      dependentId,
    ],
  );
  return appointmentId;
}
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);
const stateOf = async (id: string) =>
  (
    await pool.query(
      `SELECT a.status::text AS appt, q.state::text AS queue, q.priority_order,
              a.session_id, a.scheduled_start_at, q.registration_order::int AS reg
         FROM appointments a JOIN queue_entries q ON q.id = a.queue_entry_id
        WHERE a.id = $1`,
      [id],
    )
  ).rows[0];
const auditCount = async (id: string) =>
  Number(
    (
      await pool.query(
        `SELECT count(*) FROM audit_events WHERE entity_id = $1 AND action = 'patient_appointment_rescheduled'`,
        [id],
      )
    ).rows[0].count,
  );

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET = SECRET;
  await migrate();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE appointments, queue_entries, patient_operational_records, patient_dependents,
       consultation_sessions, doctor_clinics, doctor_profiles, clinics,
       patient_credentials, users, staff_sign_in_rate_limit_buckets CASCADE`,
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'vc-a','Clinique Al Amal')`,
    [clinic],
  );
  const doctorUser = randomUUID();
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,$2,'Dr Amine')`,
    [doctorUser, `doc-${doctorUser}`],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr Amine')`,
    [doctor, doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [clinic, doctor],
  );
  for (const [email, name] of [
    [A, 'Leila'],
    [B, 'Karim'],
  ] as const) {
    const result = await registerPatientAccount(getPool(), {
      email,
      displayName: name,
      password: PASS,
    });
    if (!result.ok) throw new Error('registration failed');
    userIds.set(email, result.userId);
  }
});
afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('patient visit reschedule options route', () => {
  it('requires a patient session', async () => {
    const id = await seedVisit(await userId(A), inDays(2));
    expect((await options(null, id)).status).toBe(401);
    expect((await options(await login(A), id)).status).toBe(200);
  });

  it('lists only valid same-doctor future planned sessions, in order, and each is accepted by reschedule', async () => {
    const a = await login(A);
    const id = await seedVisit(await userId(A), inDays(2));
    const late = await seedSession(inDays(9));
    const early = await seedSession(inDays(4));
    // Excluded: past, non-planned, other doctor, other clinic, already booked by this patient.
    await seedSession(new Date(Date.now() - 86_400_000));
    await seedSession(inDays(5), { status: 'cancelled' });
    await seedSession(inDays(6), { status: 'open' });
    const otherDoctor = randomUUID();
    const otherUser = randomUUID();
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES($1,$2,'Dr Other')`,
      [otherUser, `doc-${otherUser}`],
    );
    await pool.query(
      `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr Other')`,
      [otherDoctor, otherUser],
    );
    await pool.query(
      `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
      [clinic, otherDoctor],
    );
    await seedSession(inDays(7), { doctorId: otherDoctor });
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'vc-b','Autre clinique')`,
      [otherClinic],
    );
    await pool.query(
      `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
      [otherClinic, doctor],
    );
    await seedSession(inDays(8), { clinicId: otherClinic });
    const res = await options(a, id);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const json = await res.json();
    const ids = json.options.map((o: { sessionId: string }) => o.sessionId);
    expect(ids).toEqual([early, late]);
    for (const option of json.options) {
      expect(Object.keys(option).sort()).toEqual([
        'endsAt',
        'sessionId',
        'startsAt',
      ]);
    }
    // Positive control: a listed target is accepted by the reschedule route.
    expect((await reschedule(a, id, early)).status).toBe(200);
  });

  it('excludes a session where the same patient already holds an appointment', async () => {
    const a = await login(A);
    const id = await seedVisit(await userId(A), inDays(2));
    const target = await seedSession(inDays(5));
    const patientId = (
      await pool.query(`SELECT patient_id FROM appointments WHERE id = $1`, [
        id,
      ])
    ).rows[0].patient_id;
    const entry = randomUUID();
    await pool.query(
      `INSERT INTO queue_entries
         (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
       VALUES($1,$2,$3,$4,'waiting','appointment',1,'V-dup')`,
      [entry, clinic, target, patientId],
    );
    await pool.query(
      `INSERT INTO appointments
         (id,clinic_id,doctor_id,session_id,patient_id,queue_entry_id,status,
          scheduled_start_at,scheduled_end_at,preferred_locale)
       VALUES($1,$2,$3,$4,$5,$6,'booked',$7,$8,'fr')`,
      [
        randomUUID(),
        clinic,
        doctor,
        target,
        patientId,
        entry,
        inDays(5),
        inDays(6),
      ],
    );
    const json = await (await options(a, id)).json();
    expect(
      json.options.map((o: { sessionId: string }) => o.sessionId),
    ).not.toContain(target);
    expect((await reschedule(a, id, target)).status).toBe(409);
  });

  it('is owner scoped: another patient, unknown ids and archived dependents get 404; owned dependent succeeds', async () => {
    const a = await login(A);
    const id = await seedVisit(await userId(A), inDays(2));
    await seedSession(inDays(5));
    const b = await login(B);
    const denied = await options(b, id);
    expect(denied.status).toBe(404);
    expect(JSON.stringify(await denied.json())).not.toContain('sessionId');
    expect((await options(b, randomUUID())).status).toBe(404);
    expect((await options(a, 'not-a-uuid')).status).toBe(404);
    const archived = randomUUID();
    await pool.query(
      `INSERT INTO patient_dependents(id,owner_user_id,display_name,status,archived_at)
       VALUES($1,$2,'Old','archived',now())`,
      [archived, await userId(A)],
    );
    const archivedVisit = await seedVisit(null, inDays(3), 'booked', archived);
    expect((await options(a, archivedVisit)).status).toBe(404);
    const dep = randomUUID();
    await pool.query(
      `INSERT INTO patient_dependents(id,owner_user_id,display_name) VALUES($1,$2,'Child')`,
      [dep, await userId(A)],
    );
    const depVisit = await seedVisit(null, inDays(3), 'booked', dep);
    const ok = await options(a, depVisit);
    expect(ok.status).toBe(200);
    expect((await ok.json()).options.length).toBeGreaterThan(0);
  });

  it('refuses a visit that can no longer move with 409', async () => {
    const a = await login(A);
    await seedSession(inDays(5));
    const checkedIn = await seedVisit(
      await userId(A),
      inDays(2),
      'checked_in',
      null,
      'checked_in',
    );
    expect((await options(a, checkedIn)).status).toBe(409);
    const cancelled = await seedVisit(await userId(A), inDays(3));
    expect((await cancel(a, cancelled)).status).toBe(200);
    expect((await options(a, cancelled)).status).toBe(409);
  });

  it('is read-only', async () => {
    const a = await login(A);
    const id = await seedVisit(await userId(A), inDays(2));
    await seedSession(inDays(5));
    const before = await stateOf(id);
    await options(a, id);
    expect(await stateOf(id)).toEqual(before);
    expect(await auditCount(id)).toBe(0);
  });
});
