import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';

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
    ($1,'prio-race-reception','Reception'),($2,'prio-race-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'prio-race-clinic','Clinic')`,
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
      idempotencyKey: `prio-race-register-${index}`,
      correlationId: `prio-race-register-${index}`,
    });
    entries.push(registered.entry.id);
    await queue.command(scope, ids.session, registered.entry.id, {
      command: 'check_in',
      idempotencyKey: `prio-race-check-in-${index}`,
      correlationId: `prio-race-check-in-${index}`,
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

async function currentVersion() {
  const result = await pool.query<{ v: string }>(
    'SELECT queue_order_version::text v FROM consultation_sessions WHERE id=$1',
    [ids.session],
  );
  return Number(result.rows[0]!.v);
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
  const applicationName = `prio-race-${randomUUID()}`;
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

function reorderOn(
  racePool: Pool,
  entryId: string,
  expectedVersion: number,
  key: string,
) {
  return new QueueService(racePool).reorder(scope, ids.session, entryId, {
    targetPosition: 1,
    expectedVersion,
    idempotencyKey: key,
    reason: 'Operational accommodation',
    correlationId: key,
  });
}

async function snapshot() {
  const rows = await pool.query<{
    id: string;
    state: string;
    priority_order: string | null;
  }>(
    `SELECT id,state::text state,priority_order::text priority_order
       FROM queue_entries WHERE session_id=$1`,
    [ids.session],
  );
  const reorderReceipts = await pool.query<{ count: string }>(
    'SELECT count(*)::text count FROM queue_reorder_receipts WHERE clinic_id=$1',
    [ids.clinic],
  );
  const commandReceipts = await pool.query<{ key: string }>(
    `SELECT idempotency_key key FROM queue_command_receipts
      WHERE clinic_id=$1 AND idempotency_key LIKE 'prio-race-%'`,
    [ids.clinic],
  );
  return {
    byId: new Map(
      rows.rows.map((row) => [
        row.id,
        {
          state: row.state,
          priority:
            row.priority_order === null ? null : Number(row.priority_order),
        },
      ]),
    ),
    reorderReceipts: Number(reorderReceipts.rows[0]!.count),
    commandKeys: commandReceipts.rows
      .map((row) => row.key)
      .filter((key) => !key.startsWith('prio-race-check-in-'))
      .sort(),
  };
}

describe('priority move versus call-next and cancel races', () => {
  it('rejects a priority move queued behind a call of another entry as stale', async () => {
    const version = await currentVersion();
    let call!: ReturnType<typeof settle>;
    let move!: ReturnType<typeof settle>;
    await withSessionLockHeld(async (racePool, queueBehind) => {
      call = settle(
        new QueueService(racePool).command(scope, ids.session, entries[0]!, {
          command: 'call',
          idempotencyKey: 'prio-race-call',
          correlationId: 'prio-race-call',
        }),
      );
      await queueBehind(call);
      move = settle(
        reorderOn(racePool, entries[2]!, version, 'prio-race-move'),
      );
      await queueBehind(move);
    });
    expect((await call).status).toBe('fulfilled');
    const moveResult = await move;
    expect(moveResult.status).toBe('rejected');
    expect(String((moveResult as { reason: unknown }).reason)).toMatch(
      /Stale queue order version/,
    );
    const after = await snapshot();
    expect(after.byId.get(entries[0]!)).toEqual({
      state: 'called',
      priority: null,
    });
    expect(after.byId.get(entries[2]!)).toEqual({
      state: 'checked_in',
      priority: null,
    });
    expect(after.reorderReceipts).toBe(0);
    expect(after.commandKeys).toEqual(['prio-race-call']);
  });

  it('applies a priority move queued ahead of a call of the former head, then rejects the call as not next', async () => {
    const version = await currentVersion();
    let move!: ReturnType<typeof settle>;
    let call!: ReturnType<typeof settle>;
    await withSessionLockHeld(async (racePool, queueBehind) => {
      move = settle(
        reorderOn(racePool, entries[2]!, version, 'prio-race-move'),
      );
      await queueBehind(move);
      call = settle(
        new QueueService(racePool).command(scope, ids.session, entries[0]!, {
          command: 'call',
          idempotencyKey: 'prio-race-call',
          correlationId: 'prio-race-call',
        }),
      );
      await queueBehind(call);
    });
    expect((await move).status).toBe('fulfilled');
    const callResult = await call;
    expect(callResult.status).toBe('rejected');
    expect(String((callResult as { reason: unknown }).reason)).toMatch(
      /not next/,
    );
    const after = await snapshot();
    expect(after.byId.get(entries[2]!)).toEqual({
      state: 'checked_in',
      priority: 1,
    });
    expect(after.byId.get(entries[0]!)).toEqual({
      state: 'checked_in',
      priority: null,
    });
    expect(after.reorderReceipts).toBe(1);
    expect(after.commandKeys).toEqual([]);
  });

  it('rejects a priority move queued behind a cancel of the same entry without priority state', async () => {
    const version = await currentVersion();
    let cancel!: ReturnType<typeof settle>;
    let move!: ReturnType<typeof settle>;
    await withSessionLockHeld(async (racePool, queueBehind) => {
      cancel = settle(
        new QueueService(racePool).command(scope, ids.session, entries[1]!, {
          command: 'cancel',
          cancellationSource: 'clinic',
          reason: 'Race cancellation',
          idempotencyKey: 'prio-race-cancel',
          correlationId: 'prio-race-cancel',
        }),
      );
      await queueBehind(cancel);
      move = settle(
        reorderOn(racePool, entries[1]!, version, 'prio-race-move'),
      );
      await queueBehind(move);
    });
    expect((await cancel).status).toBe('fulfilled');
    const moveResult = await move;
    expect(moveResult.status).toBe('rejected');
    expect(String((moveResult as { reason: unknown }).reason)).toMatch(
      /Stale queue order version/,
    );
    const after = await snapshot();
    expect(after.byId.get(entries[1]!)).toEqual({
      state: 'cancelled',
      priority: null,
    });
    expect(after.reorderReceipts).toBe(0);
    expect(after.commandKeys).toEqual(['prio-race-cancel']);
  });
});
