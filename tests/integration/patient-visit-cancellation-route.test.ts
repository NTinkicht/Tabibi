import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { POST as cancelPost } from '@/app/api/patient/visits/[appointmentId]/cancel/route';
import { POST as signInPost } from '@/app/api/patient/session/route';
import { PatientVisitCancellationService } from '@/modules/patient-visit-history/cancellation';
import { PatientVisitCancellationConflictError } from '@/modules/patient-visit-history/cancellation';
import { registerPatientAccount } from '@/modules/identity/patient-credentials';
import { closePool, getPool } from '@/platform/database/pool';

// TAB-P1-04 slice 4: patient self-service cancellation of an upcoming visit.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const SECRET = 'patient-visit-cancel-secret-at-least-32-chars';
const PASS = 'correct horse battery';
const A = 'leila.cancel@example.test';
const B = 'karim.cancel@example.test';
const URL_BASE = 'http://localhost/api/patient/visits';
const clinic: string = randomUUID();
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
const cancel = (
  cookie: string | null,
  id: string,
  origin: string | null = 'http://localhost',
) =>
  cancelPost(
    new Request(`${URL_BASE}/${id}/cancel`, {
      method: 'POST',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
      },
    }),
    { params: Promise.resolve({ appointmentId: id }) },
  );
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
      `SELECT a.status::text AS appt, q.state::text AS queue, q.priority_order
         FROM appointments a JOIN queue_entries q ON q.id = a.queue_entry_id
        WHERE a.id = $1`,
      [id],
    )
  ).rows[0];
const auditCount = async (id: string) =>
  Number(
    (
      await pool.query(
        `SELECT count(*) FROM audit_events WHERE entity_id = $1 AND action = 'patient_appointment_cancelled'`,
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

describe('patient visit cancellation route', () => {
  it('requires a patient session and a same-origin request', async () => {
    const id = await seedVisit(await userId(A), inDays(2));
    const a = await login(A);
    expect((await cancel(null, id)).status).toBe(401);
    expect((await cancel(a, id, 'http://evil.example')).status).toBe(403);
    expect((await cancel(a, id, null)).status).toBe(403);
    expect((await stateOf(id)).appt).toBe('booked');
    expect((await cancel(a, id)).status).toBe(200);
  });

  it('cancels the owner visit atomically with audit and order version bump', async () => {
    const a = await login(A);
    const id = await seedVisit(await userId(A), inDays(2), 'confirmed');
    const before = (
      await pool.query(
        `SELECT queue_order_version::int AS v FROM consultation_sessions`,
      )
    ).rows[0].v;
    const res = await cancel(a, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      appointmentId: id,
      status: 'cancelled',
    });
    expect(await stateOf(id)).toMatchObject({
      appt: 'cancelled',
      queue: 'cancelled',
    });
    expect(await auditCount(id)).toBe(1);
    const after = (
      await pool.query(
        `SELECT queue_order_version::int AS v FROM consultation_sessions`,
      )
    ).rows[0].v;
    expect(after).toBe(before + 1);
  });

  it('cancels a visit for an owned active dependent', async () => {
    const a = await login(A);
    const dep = randomUUID();
    await pool.query(
      `INSERT INTO patient_dependents(id,owner_user_id,display_name) VALUES($1,$2,'Child')`,
      [dep, await userId(A)],
    );
    const id = await seedVisit(null, inDays(2), 'booked', dep);
    expect((await cancel(a, id)).status).toBe(200);
    expect((await stateOf(id)).appt).toBe('cancelled');
  });

  it('answers 404 without mutation for another account, an unknown id, or an archived dependent', async () => {
    const a = await login(A);
    const others = await seedVisit(await userId(B), inDays(2));
    const bDep = randomUUID();
    await pool.query(
      `INSERT INTO patient_dependents(id,owner_user_id,display_name) VALUES($1,$2,'Other child')`,
      [bDep, await userId(B)],
    );
    const othersDep = await seedVisit(null, inDays(2), 'booked', bDep);
    const archived = randomUUID();
    await pool.query(
      `INSERT INTO patient_dependents(id,owner_user_id,display_name,status,archived_at)
       VALUES($1,$2,'Old','archived',now())`,
      [archived, await userId(A)],
    );
    const archivedVisit = await seedVisit(null, inDays(2), 'booked', archived);
    for (const id of [others, othersDep, archivedVisit, randomUUID()]) {
      expect((await cancel(a, id)).status).toBe(404);
    }
    expect((await cancel(a, 'not-a-uuid')).status).toBe(404);
    for (const id of [others, othersDep, archivedVisit])
      expect((await stateOf(id)).appt).toBe('booked');
    // Positive control: the real owner of the same visit succeeds.
    expect((await cancel(await login(B), others)).status).toBe(200);
  });

  it('answers 409 and leaves state unchanged once the patient has arrived or the visit ended', async () => {
    const a = await login(A);
    const me = await userId(A);
    const checkedIn = await seedVisit(
      me,
      inDays(1),
      'checked_in',
      null,
      'checked_in',
    );
    const called = await seedVisit(me, inDays(1), 'checked_in', null, 'called');
    const done = await seedVisit(me, inDays(1), 'completed', null, 'completed');
    const noShow = await seedVisit(me, inDays(1), 'no_show', null, 'no_show');
    for (const id of [checkedIn, called, done, noShow]) {
      const before = await stateOf(id);
      const res = await cancel(a, id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('conflict');
      expect(await stateOf(id)).toEqual(before);
      expect(await auditCount(id)).toBe(0);
    }
    // Positive control: a waiting visit of the same account cancels.
    expect((await cancel(a, await seedVisit(me, inDays(3)))).status).toBe(200);
  });

  it('is idempotent and writes a single audit row, including under concurrency', async () => {
    const a = await login(A);
    const id = await seedVisit(await userId(A), inDays(2));
    const results = await Promise.all([
      cancel(a, id),
      cancel(a, id),
      cancel(a, id),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await cancel(a, id)).status).toBe(200);
    expect(await auditCount(id)).toBe(1);
    expect((await stateOf(id)).appt).toBe('cancelled');
  });

  it('renumbers remaining priority entries contiguously when a priority entry cancels', async () => {
    const a = await login(A);
    const me = await userId(A);
    const first = await seedVisit(me, inDays(2));
    const second = await seedVisit(me, inDays(2));
    // Put both visits in the first visit's session as priority 1 and 2.
    const sessionId = (
      await pool.query(`SELECT session_id FROM appointments WHERE id = $1`, [
        first,
      ])
    ).rows[0].session_id;
    await pool.query(
      `UPDATE queue_entries SET session_id = $2, registration_order = 2
        WHERE id = (SELECT queue_entry_id FROM appointments WHERE id = $1)`,
      [second, sessionId],
    );
    await pool.query(`UPDATE appointments SET session_id = $2 WHERE id = $1`, [
      second,
      sessionId,
    ]);
    await pool.query(
      `UPDATE queue_entries SET priority_order = 1 WHERE id = (SELECT queue_entry_id FROM appointments WHERE id = $1)`,
      [first],
    );
    await pool.query(
      `UPDATE queue_entries SET priority_order = 2 WHERE id = (SELECT queue_entry_id FROM appointments WHERE id = $1)`,
      [second],
    );
    expect((await cancel(a, first)).status).toBe(200);
    expect((await stateOf(first)).priority_order).toBeNull();
    expect(Number((await stateOf(second)).priority_order)).toBe(1);
  });
  it('refuses with a conflict, mutating nothing, when a transfer moves the visit to another session between probe and lock', async () => {
    const me = await userId(A);
    const id = await seedVisit(me, inDays(2));
    const other = await seedVisit(me, inDays(2));
    const moved = (
      await pool.query(`SELECT session_id FROM appointments WHERE id = $1`, [
        other,
      ])
    ).rows[0].session_id;
    const service = new PatientVisitCancellationService(
      getPool(),
      undefined,
      async () => {
        await pool.query(
          `UPDATE queue_entries SET session_id = $2, registration_order = 2
            WHERE id = (SELECT queue_entry_id FROM appointments WHERE id = $1)`,
          [id, moved],
        );
        await pool.query(
          `UPDATE appointments SET session_id = $2 WHERE id = $1`,
          [id, moved],
        );
      },
    );
    await expect(service.cancel(me, id)).rejects.toBeInstanceOf(
      PatientVisitCancellationConflictError,
    );
    expect((await stateOf(id)).appt).toBe('booked');
    expect(await auditCount(id)).toBe(0);
    // Positive control: without the race the same service cancels the visit.
    const control = new PatientVisitCancellationService(getPool());
    await expect(control.cancel(me, id)).resolves.toMatchObject({
      status: 'cancelled',
    });
  });
});
