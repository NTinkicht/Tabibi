import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';
import { SessionService } from '@/modules/session';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const ids = {
  clinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };
let entries: string[] = [];

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_reorder_receipts, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
    ($1,'cmd-race-reception','Reception'),($2,'cmd-race-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'cmd-race-clinic','Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.receptionist],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
    VALUES($1,$2,$3,CURRENT_DATE,CURRENT_DATE+time '09:00',CURRENT_DATE+time '12:00','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  const queue = new QueueService(pool);
  entries = [];
  for (let index = 0; index < 3; index++) {
    const registered = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: `Race ${index}`,
      preferredLocale: 'ar',
      idempotencyKey: `cmd-race-register-${index}`,
      correlationId: `cmd-race-register-${index}`,
    });
    entries.push(registered.entry.id);
    if (index === 2) continue;
    await queue.command(scope, ids.session, registered.entry.id, {
      command: 'check_in',
      idempotencyKey: `cmd-race-check-in-${index}`,
      correlationId: `cmd-race-check-in-${index}`,
    });
  }
});
afterAll(() => pool.end());

async function waitForLockWaiters(applicationName: string, expected: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text count FROM pg_stat_activity
        WHERE datname=current_database() AND application_name=$1
          AND wait_event_type='Lock'`,
      [applicationName],
    );
    if (Number(result.rows[0]?.count ?? 0) >= expected) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Expected ${expected} blocked command(s)`);
}

function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}

/**
 * Holds the session row lock on a dedicated connection, lets the caller queue
 * competing commands one at a time (each confirmed blocked before the next is
 * issued, fixing their arrival order), then releases the lock.
 */
async function withSessionLockHeld(
  body: (
    racePool: Pool,
    queueBehind: (command: Promise<unknown>) => Promise<void>,
  ) => Promise<void>,
) {
  const applicationName = `cmd-race-${randomUUID()}`;
  const racePool = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: applicationName,
    max: 4,
  });
  const blocker: PoolClient = await racePool.connect();
  let queued = 0;
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM consultation_sessions WHERE id=$1 AND clinic_id=$2 FOR UPDATE',
      [ids.session, ids.clinic],
    );
    await body(racePool, async () => {
      queued += 1;
      await waitForLockWaiters(applicationName, queued);
    });
    await blocker.query('COMMIT');
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
    await racePool.end();
  }
}

type Op = (racePool: Pool) => Promise<unknown>;

const call =
  (entry: () => string, key: string): Op =>
  (p) =>
    new QueueService(p).command(scope, ids.session, entry(), {
      command: 'call',
      idempotencyKey: key,
      correlationId: key,
    });
const queueCommand =
  (
    entry: () => string,
    command: 'check_in' | 'no_show' | 'cancel',
    key: string,
  ): Op =>
  (p) =>
    new QueueService(p).command(scope, ids.session, entry(), {
      command,
      ...(command === 'check_in' ? {} : { reason: 'Race matrix reason' }),
      ...(command === 'cancel'
        ? { cancellationSource: 'clinic' as const }
        : {}),
      idempotencyKey: key,
      correlationId: key,
    });
const sessionCommand =
  (command: 'pause' | 'cancel', key: string): Op =>
  (p) =>
    new SessionService(p).command(scope, ids.session, {
      command,
      ...(command === 'cancel' ? { reason: 'Race matrix reason' } : {}),
      idempotencyKey: key,
      correlationId: key,
    });

/** Runs `first` then `second`, fixing their serialization order. */
async function race(first: Op, second: Op) {
  let a!: ReturnType<typeof settle>;
  let b!: ReturnType<typeof settle>;
  await withSessionLockHeld(async (racePool, queueBehind) => {
    a = settle(first(racePool));
    await queueBehind(a);
    b = settle(second(racePool));
    await queueBehind(b);
  });
  return [await a, await b] as const;
}

async function states() {
  const rows = await pool.query<{ id: string; state: string }>(
    'SELECT id,state::text state FROM queue_entries WHERE session_id=$1',
    [ids.session],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row.state]));
  const session = await pool.query<{ status: string }>(
    'SELECT status::text status FROM consultation_sessions WHERE id=$1',
    [ids.session],
  );
  return {
    entry: (id: string) => byId.get(id),
    called: rows.rows.filter((row) => row.state === 'called').length,
    session: session.rows[0]!.status,
  };
}

function expectRejected(result: Awaited<ReturnType<typeof settle>>) {
  expect(result.status).toBe('rejected');
}

describe('queue command race matrix, both serialization orders', () => {
  const a = () => entries[0]!;
  const waiting = () => entries[2]!;

  it.each([['cancel'], ['no_show']] as const)(
    '%s of the head before call-next: call is rejected and the head stays terminal',
    async (command) => {
      const [first, second] = await race(
        queueCommand(a, command, 'cmd-race-mutate'),
        call(a, 'cmd-race-call'),
      );
      expect(first.status).toBe('fulfilled');
      expectRejected(second);
      const after = await states();
      expect(after.entry(a())).toBe(
        command === 'cancel' ? 'cancelled' : 'no_show',
      );
      expect(after.called).toBe(0);
    },
  );

  it.each([['cancel'], ['no_show']] as const)(
    'call-next of the head before %s: the late mutation applies from called and releases the slot',
    async (command) => {
      const [first, second] = await race(
        call(a, 'cmd-race-call'),
        queueCommand(a, command, 'cmd-race-mutate'),
      );
      expect(first.status).toBe('fulfilled');
      const after = await states();
      // cancel/no-show are legal from `called`, so the late command re-reads
      // the committed `called` state and applies; the slot is released.
      expect(second.status).toBe('fulfilled');
      expect(after.entry(a())).toBe(
        command === 'cancel' ? 'cancelled' : 'no_show',
      );
      expect(after.called).toBe(0);
    },
  );

  it('check-in before call-next: the newly eligible entry stays behind the committed cohort', async () => {
    const [first, second] = await race(
      queueCommand(waiting, 'check_in', 'cmd-race-check-in'),
      call(a, 'cmd-race-call'),
    );
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');
    const after = await states();
    expect(after.entry(a())).toBe('called');
    expect(after.entry(waiting())).toBe('checked_in');
    expect(after.called).toBe(1);
    const order = await pool.query<{ id: string }>(
      `SELECT id FROM queue_entries WHERE session_id=$1 AND state='checked_in'
        ORDER BY eligibility_order`,
      [ids.session],
    );
    expect(order.rows.map((row) => row.id)).toEqual([entries[1], waiting()]);
  });

  it('call-next before check-in: the call never selects the late entry', async () => {
    const [first, second] = await race(
      call(a, 'cmd-race-call'),
      queueCommand(waiting, 'check_in', 'cmd-race-check-in'),
    );
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');
    const after = await states();
    expect(after.entry(a())).toBe('called');
    expect(after.entry(waiting())).toBe('checked_in');
    expect(after.called).toBe(1);
  });

  it('pause before call-next: the call is refused and nothing is called', async () => {
    const [first, second] = await race(
      sessionCommand('pause', 'cmd-race-pause'),
      call(a, 'cmd-race-call'),
    );
    expect(first.status).toBe('fulfilled');
    expectRejected(second);
    const after = await states();
    expect(after.session).toBe('paused');
    expect(after.called).toBe(0);
    expect(after.entry(a())).toBe('checked_in');
  });

  it('call-next before pause: the committed call is preserved', async () => {
    const [first, second] = await race(
      call(a, 'cmd-race-call'),
      sessionCommand('pause', 'cmd-race-pause'),
    );
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');
    const after = await states();
    expect(after.session).toBe('paused');
    expect(after.entry(a())).toBe('called');
    expect(after.called).toBe(1);
  });

  it('whole-session cancel before call-next: the call is refused', async () => {
    const [first, second] = await race(
      sessionCommand('cancel', 'cmd-race-session-cancel'),
      call(a, 'cmd-race-call'),
    );
    expect(first.status).toBe('fulfilled');
    expectRejected(second);
    const after = await states();
    expect(after.session).toBe('cancelled');
    expect(after.called).toBe(0);
    expect(after.entry(a())).toBe('cancelled');
  });

  it('call-next before whole-session cancel: the called entry is cascaded to cancelled', async () => {
    const [first, second] = await race(
      call(a, 'cmd-race-call'),
      sessionCommand('cancel', 'cmd-race-session-cancel'),
    );
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');
    const after = await states();
    expect(after.session).toBe('cancelled');
    expect(after.called).toBe(0);
    expect(after.entry(a())).toBe('cancelled');
  });
});
