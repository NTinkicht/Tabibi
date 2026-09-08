import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueueService } from '@/modules/queue';
import { ReceptionistDashboardService } from '@/modules/receptionist-dashboard';
import { SessionService } from '@/modules/session';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function poolWithDashboardFirstQueryBarrier(
  reached: ReturnType<typeof deferred>,
  release: ReturnType<typeof deferred>,
  afterConcurrentCommitProbe?: (client: PoolClient) => Promise<void>,
): Pool {
  return {
    connect: async () => {
      const client = await pool.connect();
      const originalQuery = client.query.bind(client);
      let held = false;
      let probed = false;

      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(originalQuery, target, args);
              const firstArg = args[0];
              const sql =
                typeof firstArg === 'string'
                  ? firstArg
                  : typeof firstArg === 'object' &&
                      firstArg !== null &&
                      'text' in firstArg
                    ? String((firstArg as { text?: unknown }).text ?? '')
                    : '';

              if (!held && sql.includes('FROM consultation_sessions session')) {
                held = true;
                reached.resolve();
                await release.promise;
              } else if (
                held &&
                !probed &&
                afterConcurrentCommitProbe &&
                sql.includes('completed_at IS NOT NULL')
              ) {
                probed = true;
                await afterConcurrentCommitProbe(target as PoolClient);
              }
              return result;
            };
          }

          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Pool;
}

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_command_receipts, queue_reorder_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
    ($1,'wu10-reception','Reception'),($2,'wu10-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES ($1,'wu10-clinic','WU10')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.receptionist],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr WU10')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
    (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status,declared_delay_minutes,delay_version,delay_updated_at)
    VALUES ($1,$2,$3,'2026-09-08','2026-09-08 09:00Z','2026-09-08 12:00Z','open',NULL,0,NULL)`,
    [ids.session, ids.clinic, ids.doctor],
  );
});
afterAll(async () => pool.end());

async function progress(
  queue: QueueService,
  entryId: string,
  commands: Array<
    'check_in' | 'call' | 'start_consultation' | 'complete_consultation'
  >,
  prefix: string,
) {
  for (const [index, command] of commands.entries()) {
    await queue.command(scope, ids.session, entryId, {
      command,
      idempotencyKey: `${prefix}-${index}`,
      correlationId: `${prefix}-${index}`,
    });
  }
}

describe('receptionist dashboard concurrency snapshot', () => {
  it('keeps lifecycle state and duration samples on one committed PostgreSQL snapshot', async () => {
    const queue = new QueueService(pool);

    for (let index = 0; index < 2; index++) {
      const completed = await queue.registerWalkIn(scope, ids.session, {
        privateDisplayName: `Completed ${index}`,
        preferredLocale: 'fr',
        idempotencyKey: `wu10-completed-register-${index}`,
        correlationId: `wu10-completed-register-${index}`,
      });
      await progress(
        queue,
        completed.entry.id,
        ['check_in', 'call', 'start_consultation', 'complete_consultation'],
        `wu10-completed-${index}`,
      );
      await pool.query(
        `UPDATE queue_entries
            SET completed_at = '2026-09-08 10:00Z'::timestamptz,
                in_consultation_started_at = '2026-09-08 09:50Z'::timestamptz
          WHERE id = $1`,
        [completed.entry.id],
      );
    }

    const racing = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: 'Racing consultation',
      preferredLocale: 'ar',
      idempotencyKey: 'wu10-racing-register',
      correlationId: 'wu10-racing-register',
    });
    await progress(
      queue,
      racing.entry.id,
      ['check_in', 'call', 'start_consultation'],
      'wu10-racing',
    );
    await pool.query(
      `UPDATE queue_entries
          SET in_consultation_started_at = now() - interval '10 minutes'
        WHERE id = $1`,
      [racing.entry.id],
    );

    const firstQueryReached = deferred();
    const releaseFirstQuery = deferred();
    const service = new ReceptionistDashboardService(
      poolWithDashboardFirstQueryBarrier(firstQueryReached, releaseFirstQuery),
    );

    const snapshotPromise = service.getSnapshot(scope, ids.session);
    await firstQueryReached.promise;

    await queue.command(scope, ids.session, racing.entry.id, {
      command: 'complete_consultation',
      idempotencyKey: 'wu10-racing-complete',
      correlationId: 'wu10-racing-complete',
    });
    releaseFirstQuery.resolve();

    const snapshot = await snapshotPromise;
    const racedEntry = snapshot.entries.find(
      (entry) => entry.id === racing.entry.id,
    )!;

    expect(racedEntry.state).toBe('in_consultation');
    expect(racedEntry.eta).toMatchObject({
      estimateSource: 'fallback',
      observedSampleCount: 2,
    });

    const after = await new ReceptionistDashboardService(pool).getSnapshot(
      scope,
      ids.session,
    );
    expect(
      after.entries.find((entry) => entry.id === racing.entry.id),
    ).toMatchObject({
      state: 'completed',
      eta: null,
    });
  });

  it('pins doctor-delay update fields across a concurrent commit', async () => {
    const queue = new QueueService(pool);
    const sessions = new SessionService(pool);
    const entry = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: 'Delay patient',
      preferredLocale: 'fr',
      idempotencyKey: 'wu10-delay-register',
      correlationId: 'wu10-delay-register',
    });
    await progress(queue, entry.entry.id, ['check_in'], 'wu10-delay-check-in');

    await sessions.delay(scope, ids.session, {
      command: 'declare_delay',
      minutes: 10,
      expectedVersion: 0,
      idempotencyKey: 'wu10-delay-declare',
      correlationId: 'wu10-delay-declare',
    });

    let probe:
      | { declaredDelayMinutes: number | null; delayVersion: number }
      | undefined;
    const firstQueryReached = deferred();
    const releaseFirstQuery = deferred();
    const service = new ReceptionistDashboardService(
      poolWithDashboardFirstQueryBarrier(
        firstQueryReached,
        releaseFirstQuery,
        async (client) => {
          const observed = await client.query<{
            declared_delay_minutes: number | null;
            delay_version: number;
          }>(
            `SELECT declared_delay_minutes, delay_version
               FROM consultation_sessions
              WHERE id = $1 AND clinic_id = $2`,
            [ids.session, ids.clinic],
          );
          probe = {
            declaredDelayMinutes:
              observed.rows[0]?.declared_delay_minutes ?? null,
            delayVersion: observed.rows[0]?.delay_version ?? -1,
          };
        },
      ),
    );
    const snapshotPromise = service.getSnapshot(scope, ids.session);
    await firstQueryReached.promise;

    await sessions.delay(scope, ids.session, {
      command: 'update_delay',
      minutes: 40,
      expectedVersion: 1,
      idempotencyKey: 'wu10-delay-update',
      correlationId: 'wu10-delay-update',
    });
    releaseFirstQuery.resolve();

    const snapshot = await snapshotPromise;
    expect(probe).toEqual({ declaredDelayMinutes: 10, delayVersion: 1 });
    expect(snapshot.session).toMatchObject({
      declaredDelayMinutes: 10,
      delayVersion: 1,
    });
    expect(snapshot.entries[0]?.eta).toMatchObject({
      patientsAhead: 0,
      minWaitMinutes: 10,
      maxWaitMinutes: 10,
    });

    const after = await new ReceptionistDashboardService(pool).getSnapshot(
      scope,
      ids.session,
    );
    expect(after.session).toMatchObject({
      declaredDelayMinutes: 40,
      delayVersion: 2,
    });
  });

  it('pins nullable doctor-delay fields across a concurrent clear', async () => {
    const sessions = new SessionService(pool);
    await sessions.delay(scope, ids.session, {
      command: 'declare_delay',
      minutes: 25,
      expectedVersion: 0,
      idempotencyKey: 'wu10-clear-declare',
      correlationId: 'wu10-clear-declare',
    });

    let probe:
      | { declaredDelayMinutes: number | null; delayVersion: number }
      | undefined;
    const firstQueryReached = deferred();
    const releaseFirstQuery = deferred();
    const service = new ReceptionistDashboardService(
      poolWithDashboardFirstQueryBarrier(
        firstQueryReached,
        releaseFirstQuery,
        async (client) => {
          const observed = await client.query<{
            declared_delay_minutes: number | null;
            delay_version: number;
          }>(
            `SELECT declared_delay_minutes, delay_version
               FROM consultation_sessions
              WHERE id = $1 AND clinic_id = $2`,
            [ids.session, ids.clinic],
          );
          probe = {
            declaredDelayMinutes:
              observed.rows[0]?.declared_delay_minutes ?? null,
            delayVersion: observed.rows[0]?.delay_version ?? -1,
          };
        },
      ),
    );
    const snapshotPromise = service.getSnapshot(scope, ids.session);
    await firstQueryReached.promise;

    await sessions.delay(scope, ids.session, {
      command: 'clear_delay',
      expectedVersion: 1,
      idempotencyKey: 'wu10-delay-clear',
      correlationId: 'wu10-delay-clear',
    });
    releaseFirstQuery.resolve();

    const snapshot = await snapshotPromise;
    expect(probe).toEqual({ declaredDelayMinutes: 25, delayVersion: 1 });
    expect(snapshot.session).toMatchObject({
      declaredDelayMinutes: 25,
      delayVersion: 1,
    });

    const after = await new ReceptionistDashboardService(pool).getSnapshot(
      scope,
      ids.session,
    );
    expect(after.session).toMatchObject({
      declaredDelayMinutes: null,
      delayVersion: 2,
    });
  });

  it('pins priority reorder fields across a concurrent commit', async () => {
    const queue = new QueueService(pool);
    const first = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: 'Priority first',
      preferredLocale: 'fr',
      idempotencyKey: 'wu10-priority-first-register',
      correlationId: 'wu10-priority-first-register',
    });
    const second = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: 'Priority second',
      preferredLocale: 'ar',
      idempotencyKey: 'wu10-priority-second-register',
      correlationId: 'wu10-priority-second-register',
    });
    await progress(queue, first.entry.id, ['check_in'], 'wu10-priority-first');
    await progress(
      queue,
      second.entry.id,
      ['check_in'],
      'wu10-priority-second',
    );

    const beforePriority = await new ReceptionistDashboardService(
      pool,
    ).getSnapshot(scope, ids.session);
    await queue.reorder(scope, ids.session, first.entry.id, {
      targetPosition: 1,
      expectedVersion: beforePriority.session.queueOrderVersion,
      reason: 'WU10 deterministic priority setup',
      idempotencyKey: 'wu10-priority-seed',
      correlationId: 'wu10-priority-seed',
    });

    const seeded = await new ReceptionistDashboardService(pool).getSnapshot(
      scope,
      ids.session,
    );
    let probe:
      | { queueOrderVersion: number; orderedEntryIds: string[] }
      | undefined;
    const firstQueryReached = deferred();
    const releaseFirstQuery = deferred();
    const service = new ReceptionistDashboardService(
      poolWithDashboardFirstQueryBarrier(
        firstQueryReached,
        releaseFirstQuery,
        async (client) => {
          const version = await client.query<{ queue_order_version: number }>(
            `SELECT queue_order_version
               FROM consultation_sessions
              WHERE id = $1 AND clinic_id = $2`,
            [ids.session, ids.clinic],
          );
          const order = await client.query<{ id: string }>(
            `SELECT id
               FROM queue_entries
              WHERE session_id = $1 AND clinic_id = $2
              ORDER BY CASE WHEN priority_order IS NULL THEN 1 ELSE 0 END,
                       priority_order NULLS LAST,
                       eligibility_order NULLS LAST,
                       registration_order NULLS LAST,
                       id NULLS LAST`,
            [ids.session, ids.clinic],
          );
          probe = {
            queueOrderVersion: Number(
              version.rows[0]?.queue_order_version ?? -1,
            ),
            orderedEntryIds: order.rows.map((row) => row.id),
          };
        },
      ),
    );
    const snapshotPromise = service.getSnapshot(scope, ids.session);
    await firstQueryReached.promise;

    await queue.reorder(scope, ids.session, second.entry.id, {
      targetPosition: 1,
      expectedVersion: seeded.session.queueOrderVersion,
      reason: 'WU10 concurrent priority reorder',
      idempotencyKey: 'wu10-priority-race',
      correlationId: 'wu10-priority-race',
    });
    releaseFirstQuery.resolve();

    const snapshot = await snapshotPromise;
    expect(probe).toEqual({
      queueOrderVersion: seeded.session.queueOrderVersion,
      orderedEntryIds: [first.entry.id, second.entry.id],
    });
    expect(snapshot.session.queueOrderVersion).toBe(
      seeded.session.queueOrderVersion,
    );
    expect(snapshot.entries.map((entry) => entry.id)).toEqual([
      first.entry.id,
      second.entry.id,
    ]);
    expect(snapshot.entries.map((entry) => entry.eta?.patientsAhead)).toEqual([
      0, 1,
    ]);

    const after = await new ReceptionistDashboardService(pool).getSnapshot(
      scope,
      ids.session,
    );
    expect(after.session.queueOrderVersion).toBe(
      seeded.session.queueOrderVersion + 1,
    );
    expect(after.entries.map((entry) => entry.id)).toEqual([
      second.entry.id,
      first.entry.id,
    ]);
  });
});
