import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueueService } from '@/modules/queue';
import { ReceptionistDashboardService } from '@/modules/receptionist-dashboard';
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
): Pool {
  return {
    connect: async () => {
      const client = await pool.connect();
      const originalQuery = client.query.bind(client);
      let held = false;

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
});
