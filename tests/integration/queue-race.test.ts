import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
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
    ($1,'race-reception','Reception'),($2,'race-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'race-clinic','Clinic')`,
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
      privateDisplayName: `Race Patient ${index}`,
      preferredLocale: 'ar',
      idempotencyKey: `race-register-${index}`,
      correlationId: `race-register-${index}`,
    });
    entries.push(registered.entry.id);
    await queue.command(scope, ids.session, registered.entry.id, {
      command: 'check_in',
      idempotencyKey: `race-check-in-${index}`,
      correlationId: `race-check-in-${index}`,
    });
  }
});
afterAll(() => pool.end());

async function version(): Promise<number> {
  const row = await pool.query<{ queue_order_version: string }>(
    'SELECT queue_order_version FROM consultation_sessions WHERE id=$1',
    [ids.session],
  );
  return Number(row.rows[0]!.queue_order_version);
}

async function auditCount(action: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM audit_events WHERE action=$1',
    [action],
  );
  return Number(result.rows[0]!.count);
}

async function waitForLockWaiters(
  applicationName: string,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE datname=current_database()
          AND application_name=$1
          AND wait_event_type='Lock'`,
      [applicationName],
    );
    if (Number(result.rows[0]?.count ?? 0) >= expected) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Expected ${expected} blocked queue mutation(s)`);
}

async function withSessionLockRace<T>(
  run: (
    racePool: Pool,
    queued: (expected: number) => Promise<void>,
    release: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const applicationName = `queue-race-${randomUUID()}`;
  const racePool = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: applicationName,
    max: 4,
  });
  const blocker = await racePool.connect();
  let released = false;
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      `SELECT id FROM consultation_sessions
        WHERE id=$1 AND clinic_id=$2 FOR UPDATE`,
      [ids.session, ids.clinic],
    );
    return await run(
      racePool,
      (expected) => waitForLockWaiters(applicationName, expected),
      async () => {
        await blocker.query('COMMIT');
        released = true;
      },
    );
  } catch (error) {
    if (!released) await blocker.query('ROLLBACK');
    throw error;
  } finally {
    blocker.release();
    await racePool.end();
  }
}

describe('deterministic queue concurrency regressions', () => {
  it('serializes same-entry concurrent call-next attempts into one called slot', async () => {
    const results = await withSessionLockRace(
      async (racePool, queued, release) => {
        const queue = new QueueService(racePool);
        const first = queue.command(scope, ids.session, entries[0]!, {
          command: 'call',
          idempotencyKey: 'call-race-a',
          correlationId: 'call-race-a',
        });
        await queued(1);
        const second = queue.command(scope, ids.session, entries[0]!, {
          command: 'call',
          idempotencyKey: 'call-race-b',
          correlationId: 'call-race-b',
        });
        await queued(2);
        await release();
        return Promise.allSettled([first, second]);
      },
    );

    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('rejected');
    expect(results[1]).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringMatching(/Cannot apply call.*called/),
      }),
    });

    const called = await pool.query<{ id: string }>(
      `SELECT id FROM queue_entries WHERE session_id=$1 AND state='called'`,
      [ids.session],
    );
    expect(called.rows.map((row) => row.id)).toEqual([entries[0]]);
    expect(await version()).toBe(4);
    expect(await auditCount('queue_entry.call')).toBe(1);
  });

  it('allows only one same-version priority override to commit', async () => {
    const results = await withSessionLockRace(
      async (racePool, queued, release) => {
        const first = new QueueService(racePool).reorder(
          scope,
          ids.session,
          entries[1]!,
          {
            targetPosition: 1,
            expectedVersion: 3,
            idempotencyKey: 'priority-race-a',
            reason: 'Deterministic race regression',
            correlationId: 'priority-race-a',
          },
        );
        await queued(1);
        const second = new QueueService(racePool).reorder(
          scope,
          ids.session,
          entries[2]!,
          {
            targetPosition: 1,
            expectedVersion: 3,
            idempotencyKey: 'priority-race-b',
            reason: 'Deterministic race regression',
            correlationId: 'priority-race-b',
          },
        );
        await queued(2);
        await release();
        return Promise.allSettled([first, second]);
      },
    );

    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('rejected');
    expect(results[1]).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringMatching(/Stale queue order version/),
      }),
    });
    expect(await version()).toBe(4);
    expect(await auditCount('queue_entry.reordered')).toBe(1);

    const priority = await pool.query<{
      id: string;
      priority_order: string;
    }>(
      `SELECT id,priority_order FROM queue_entries
        WHERE session_id=$1 AND priority_order IS NOT NULL
        ORDER BY priority_order,registration_order`,
      [ids.session],
    );
    expect(priority.rows).toEqual([{ id: entries[1], priority_order: '1' }]);
  });

  it('commits call-next before rejecting the queued stale priority override', async () => {
    const results = await withSessionLockRace(
      async (racePool, queued, release) => {
        const queue = new QueueService(racePool);
        const call = queue.command(scope, ids.session, entries[0]!, {
          command: 'call',
          idempotencyKey: 'call-versus-priority-call',
          correlationId: 'call-versus-priority-call',
        });
        await queued(1);
        const override = new QueueService(racePool).reorder(
          scope,
          ids.session,
          entries[2]!,
          {
            targetPosition: 1,
            expectedVersion: 3,
            idempotencyKey: 'call-versus-priority-reorder',
            reason: 'Deterministic race regression',
            correlationId: 'call-versus-priority-reorder',
          },
        );
        await queued(2);
        await release();
        return Promise.allSettled([call, override]);
      },
    );

    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('rejected');
    expect(results[1]).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringMatching(/Stale queue order version/),
      }),
    });
    expect(await version()).toBe(4);
    expect(await auditCount('queue_entry.call')).toBe(1);
    expect(await auditCount('queue_entry.reordered')).toBe(0);
    const called = await pool.query<{ id: string }>(
      `SELECT id FROM queue_entries WHERE session_id=$1 AND state='called'`,
      [ids.session],
    );
    expect(called.rows).toEqual([{ id: entries[0] }]);
  });

  it('commits a queued priority override before call-next selects its entry', async () => {
    const results = await withSessionLockRace(
      async (racePool, queued, release) => {
        const queue = new QueueService(racePool);
        const override = queue.reorder(scope, ids.session, entries[2]!, {
          targetPosition: 1,
          expectedVersion: 3,
          idempotencyKey: 'override-first',
          reason: 'Deterministic race regression',
          correlationId: 'override-first',
        });
        await queued(1);
        const call = queue.command(scope, ids.session, entries[2]!, {
          command: 'call',
          idempotencyKey: 'override-first-call',
          correlationId: 'override-first-call',
        });
        await queued(2);
        await release();
        return Promise.allSettled([override, call]);
      },
    );

    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('fulfilled');
    expect(await version()).toBe(5);
    expect(await auditCount('queue_entry.reordered')).toBe(1);
    expect(await auditCount('queue_entry.call')).toBe(1);

    const called = await pool.query<{ id: string }>(
      `SELECT id FROM queue_entries WHERE session_id=$1 AND state='called'`,
      [ids.session],
    );
    expect(called.rows).toEqual([{ id: entries[2] }]);

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
        WHERE action='queue_entry.reordered' AND entity_id=$1`,
      [entries[2]],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({
      previousVersion: 3,
      resultingVersion: 4,
      targetPosition: 1,
    });
  });
});
