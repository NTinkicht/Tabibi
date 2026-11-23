import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { POST as reschedulePost } from '@/app/api/patient/visits/[appointmentId]/reschedule/route';
import { POST as cancelPost } from '@/app/api/patient/visits/[appointmentId]/cancel/route';
import { POST as signInPost } from '@/app/api/patient/session/route';
import {
  PatientVisitRescheduleConflictError,
  PatientVisitRescheduleService,
} from '@/modules/patient-visit-history/reschedule';
import { registerPatientAccount } from '@/modules/identity/patient-credentials';
import { closePool, getPool } from '@/platform/database/pool';

// TAB-P1-04 slice 6: patient self-service rescheduling of an upcoming visit.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const SECRET = 'patient-visit-resched-secret-at-least-32-chars';
const PASS = 'correct horse battery';
const A = 'leila.resched@example.test';
const B = 'karim.resched@example.test';
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

describe('patient visit reschedule route', () => {
  it('requires a patient session and a same-origin request', async () => {
    const id = await seedVisit(await userId(A), inDays(2));
    const target = await seedSession(inDays(5));
    const a = await login(A);
    expect((await reschedule(null, id, target)).status).toBe(401);
    expect(
      (await reschedule(a, id, target, 'http://evil.example')).status,
    ).toBe(403);
    expect((await reschedule(a, id, target, null)).status).toBe(403);
    expect((await stateOf(id)).session_id).not.toBe(target);
    expect((await reschedule(a, id, target)).status).toBe(200);
  });

  it('moves the owner visit atomically: new waiting tail entry, old cancelled, window, audit, versions', async () => {
    const a = await login(A);
    const id = await seedVisit(await userId(A), inDays(2), 'confirmed');
    const target = await seedSession(inDays(5));
    // Another patient already waits in the target so the tail order is 2.
    const otherId = await seedVisit(await userId(B), inDays(5));
    await pool.query(
      `UPDATE queue_entries SET session_id = $2, registration_order = 1
        WHERE id = (SELECT queue_entry_id FROM appointments WHERE id = $1)`,
      [otherId, target],
    );
    await pool.query(`UPDATE appointments SET session_id = $2 WHERE id = $1`, [
      otherId,
      target,
    ]);
    const oldEntry = (
      await pool.query(
        `SELECT queue_entry_id, session_id FROM appointments WHERE id = $1`,
        [id],
      )
    ).rows[0];
    const res = await reschedule(a, id, target);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.appointmentId).toBe(id);
    expect(json.status).toBe('confirmed');
    expect(Object.keys(json).sort()).toEqual([
      'appointmentId',
      'scheduledEndAt',
      'scheduledStartAt',
      'status',
    ]);
    const state = await stateOf(id);
    expect(state).toMatchObject({
      appt: 'confirmed',
      queue: 'waiting',
      session_id: target,
      reg: 2,
    });
    const targetRow = (
      await pool.query(
        `SELECT starts_at FROM consultation_sessions WHERE id = $1`,
        [target],
      )
    ).rows[0];
    expect(new Date(state.scheduled_start_at).toISOString()).toBe(
      targetRow.starts_at.toISOString(),
    );
    expect(json.scheduledStartAt).toBe(targetRow.starts_at.toISOString());
    const old = (
      await pool.query(
        `SELECT state::text, priority_order FROM queue_entries WHERE id = $1`,
        [oldEntry.queue_entry_id],
      )
    ).rows[0];
    expect(old).toMatchObject({ state: 'cancelled', priority_order: null });
    expect(await auditCount(id)).toBe(1);
    const versions = (
      await pool.query(
        `SELECT id, queue_order_version::int AS v FROM consultation_sessions
          WHERE id = ANY($1::uuid[])`,
        [[oldEntry.session_id, target]],
      )
    ).rows;
    expect(versions.every((v) => v.v === 1)).toBe(true);
  });

  it('answers 404 without mutation for another account, an unknown id, or an archived dependent', async () => {
    const a = await login(A);
    const target = await seedSession(inDays(5));
    const others = await seedVisit(await userId(B), inDays(2));
    const archived = randomUUID();
    await pool.query(
      `INSERT INTO patient_dependents(id,owner_user_id,display_name,status,archived_at)
       VALUES($1,$2,'Old','archived',now())`,
      [archived, await userId(A)],
    );
    const archivedVisit = await seedVisit(null, inDays(2), 'booked', archived);
    for (const id of [others, archivedVisit, randomUUID()])
      expect((await reschedule(a, id, target)).status).toBe(404);
    expect((await reschedule(a, 'not-a-uuid', target)).status).toBe(404);
    for (const id of [others, archivedVisit])
      expect((await stateOf(id)).session_id).not.toBe(target);
    // Positive control: the real owner of the same visit succeeds.
    expect((await reschedule(await login(B), others, target)).status).toBe(200);
  });

  it('reschedules a visit for an owned active dependent', async () => {
    const a = await login(A);
    const dep = randomUUID();
    await pool.query(
      `INSERT INTO patient_dependents(id,owner_user_id,display_name) VALUES($1,$2,'Child')`,
      [dep, await userId(A)],
    );
    const id = await seedVisit(null, inDays(2), 'booked', dep);
    const target = await seedSession(inDays(5));
    expect((await reschedule(a, id, target)).status).toBe(200);
    expect((await stateOf(id)).session_id).toBe(target);
  });

  it('answers 409 and mutates nothing for unusable targets', async () => {
    const a = await login(A);
    const id = await seedVisit(await userId(A), inDays(3));
    const before = await stateOf(id);
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
    const foreignClinic = randomUUID();
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'vc-b','Autre clinique')`,
      [foreignClinic],
    );
    await pool.query(
      `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
      [foreignClinic, doctor],
    );
    const bad: unknown[] = [
      await seedSession(inDays(5), { doctorId: otherDoctor }),
      await seedSession(inDays(5), { clinicId: foreignClinic }),
      await seedSession(inDays(5), { status: 'open' }),
      await seedSession(inDays(5), { status: 'closed' }),
      await seedSession(new Date(Date.now() - 3_600_000)),
      randomUUID(),
      'not-a-uuid',
    ];
    for (const target of bad) {
      const res = await reschedule(a, id, target);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('conflict');
      expect(await stateOf(id)).toEqual(before);
    }
    expect(await auditCount(id)).toBe(0);
    // Requesting the current session is an idempotent no-op, not a move.
    expect((await reschedule(a, id, before.session_id)).status).toBe(200);
    expect(await stateOf(id)).toEqual(before);
    expect(await auditCount(id)).toBe(0);
    // Positive control: a planned future session of the same doctor works.
    expect((await reschedule(a, id, await seedSession(inDays(6)))).status).toBe(
      200,
    );
  });

  it('refuses when the patient already has an appointment in the target session', async () => {
    const a = await login(A);
    const me = await userId(A);
    const first = await seedVisit(me, inDays(2));
    const targetSession = await seedSession(inDays(4));
    const patientId = (
      await pool.query(`SELECT patient_id FROM appointments WHERE id = $1`, [
        first,
      ])
    ).rows[0].patient_id;
    const dupEntry = randomUUID();
    await pool.query(
      `INSERT INTO queue_entries
         (id,clinic_id,session_id,patient_id,state,source,registration_order)
       VALUES($1,$2,$3,$4,'waiting','appointment',1)`,
      [dupEntry, clinic, targetSession, patientId],
    );
    await pool.query(
      `INSERT INTO appointments
         (id,clinic_id,doctor_id,session_id,patient_id,queue_entry_id,status,
          scheduled_start_at,scheduled_end_at,preferred_locale)
       VALUES($1,$2,$3,$4,$5,$6,'booked',now(),now() + interval '15 minutes','fr')`,
      [randomUUID(), clinic, doctor, targetSession, patientId, dupEntry],
    );
    const before = await stateOf(first);
    expect((await reschedule(a, first, targetSession)).status).toBe(409);
    expect(await stateOf(first)).toEqual(before);
    // Positive control: a free session accepts the same visit.
    expect(
      (await reschedule(a, first, await seedSession(inDays(6)))).status,
    ).toBe(200);
  });

  it('answers 409 once the patient has arrived or the visit ended', async () => {
    const a = await login(A);
    const me = await userId(A);
    const target = await seedSession(inDays(9));
    const checkedIn = await seedVisit(
      me,
      inDays(1),
      'checked_in',
      null,
      'checked_in',
    );
    const done = await seedVisit(me, inDays(1), 'completed', null, 'completed');
    const gone = await seedVisit(me, inDays(1), 'cancelled', null, 'cancelled');
    for (const id of [checkedIn, done, gone]) {
      const before = await stateOf(id);
      expect((await reschedule(a, id, target)).status).toBe(409);
      expect(await stateOf(id)).toEqual(before);
    }
    expect(await auditCount(checkedIn)).toBe(0);
    expect(
      (await reschedule(a, await seedVisit(me, inDays(2)), target)).status,
    ).toBe(200);
  });

  it('is idempotent for the same target, including under concurrency, with one audit row', async () => {
    const a = await login(A);
    const id = await seedVisit(await userId(A), inDays(2));
    const target = await seedSession(inDays(5));
    const results = await Promise.all([
      reschedule(a, id, target),
      reschedule(a, id, target),
      reschedule(a, id, target),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await auditCount(id)).toBe(1);
    const live = await pool.query(
      `SELECT count(*)::int AS n FROM queue_entries
        WHERE state = 'waiting' AND session_id = $1`,
      [target],
    );
    expect(live.rows[0].n).toBe(1);
  });

  it('loses cleanly to a concurrent cancellation: no waiting entry is left behind', async () => {
    const a = await login(A);
    const id = await seedVisit(await userId(A), inDays(2));
    const target = await seedSession(inDays(5));
    const [r, c] = await Promise.all([
      reschedule(a, id, target),
      cancel(a, id),
    ]);
    expect([200, 409]).toContain(r.status);
    expect([200, 409]).toContain(c.status);
    // First commit wins and the visit is never both cancelled and waiting.
    const waiting = (
      await pool.query(
        `SELECT count(*)::int AS n FROM queue_entries WHERE state = 'waiting'`,
      )
    ).rows[0].n;
    const state = await stateOf(id);
    if (c.status === 200) {
      expect(state.appt).toBe('cancelled');
      expect(waiting).toBe(0);
    } else {
      // The cancel probed the old session, lost the race and is told to retry.
      expect(r.status).toBe(200);
      expect(state).toMatchObject({ appt: 'booked', queue: 'waiting' });
      expect(waiting).toBe(1);
      expect((await cancel(a, id)).status).toBe(200);
    }
  });

  it('refuses with a conflict, mutating nothing, when a transfer moves the visit between probe and lock', async () => {
    const me = await userId(A);
    const id = await seedVisit(me, inDays(2));
    const other = await seedVisit(me, inDays(2));
    const target = await seedSession(inDays(5));
    const moved = (
      await pool.query(`SELECT session_id FROM appointments WHERE id = $1`, [
        other,
      ])
    ).rows[0].session_id;
    const service = new PatientVisitRescheduleService(
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
    await expect(service.reschedule(me, id, target)).rejects.toBeInstanceOf(
      PatientVisitRescheduleConflictError,
    );
    expect((await stateOf(id)).session_id).toBe(moved);
    expect(await auditCount(id)).toBe(0);
    // Positive control: without the race the same service moves the visit.
    const control = new PatientVisitRescheduleService(getPool());
    await expect(control.reschedule(me, id, target)).resolves.toMatchObject({
      appointmentId: id,
    });
  });

  it('fails closed with 404 when a dependent archive commits first, creating no new entry', async () => {
    const a = await login(A);
    const dep = randomUUID();
    await pool.query(
      `INSERT INTO patient_dependents(id,owner_user_id,display_name) VALUES($1,$2,'Child')`,
      [dep, await userId(A)],
    );
    const id = await seedVisit(null, inDays(2), 'booked', dep);
    const target = await seedSession(inDays(5));
    const before = await stateOf(id);
    const archiver = await pool.connect();
    try {
      await archiver.query('BEGIN');
      await archiver.query(
        `UPDATE patient_dependents
            SET status='archived', archived_at=now(), updated_at=now()
          WHERE id=$1`,
        [dep],
      );
      const pending = reschedule(a, id, target);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await archiver.query('COMMIT');
      expect((await pending).status).toBe(404);
    } finally {
      await archiver.query('ROLLBACK').catch(() => undefined);
      archiver.release();
    }
    expect(await stateOf(id)).toEqual(before);
    expect(await auditCount(id)).toBe(0);
    const live = await pool.query(
      `SELECT count(*)::int AS n FROM queue_entries WHERE session_id = $1`,
      [target],
    );
    expect(live.rows[0].n).toBe(0);
  });
});
