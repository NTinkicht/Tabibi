import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReceptionistDashboardService } from '@/modules/receptionist-dashboard';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  targetSession: randomUUID(),
  historySession: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function poolWithMainQueryBarrier(
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

async function insertDuration(
  client: Pool | PoolClient,
  durationMinutes: number,
  registrationOrder: number,
) {
  const patientId = randomUUID();
  const entryId = randomUUID();
  const completedAt = new Date('2099-05-14T10:00:00.000Z');
  await client.query(
    `INSERT INTO patient_operational_records
      (id,clinic_id,private_display_name,preferred_locale)
     VALUES ($1,$2,'WU68 Historical','fr')`,
    [patientId, ids.clinic],
  );
  await client.query(
    `INSERT INTO queue_entries
      (id,clinic_id,session_id,patient_id,state,source,registration_order,
       in_consultation_started_at,completed_at)
     VALUES ($1,$2,$3,$4,'completed','walk_in',$5,$6,$7)`,
    [
      entryId,
      ids.clinic,
      ids.historySession,
      patientId,
      registrationOrder,
      new Date(completedAt.getTime() - durationMinutes * 60_000),
      completedAt,
    ],
  );
}

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_command_receipts, queue_reorder_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'wu68-race-reception','Reception'),($2,'wu68-race-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'wu68-race-clinic','WU68 Race')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.receptionist],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr WU68')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status,declared_delay_minutes)
     VALUES
      ($1,$3,$4,'2099-05-15','2099-05-15 08:00Z','2099-05-15 09:00Z','open',NULL),
      ($2,$3,$4,'2099-05-14','2099-05-14 08:00Z','2099-05-14 12:00Z','closed',NULL)`,
    [ids.targetSession, ids.historySession, ids.clinic, ids.doctor],
  );

  for (let index = 0; index < 2; index++) {
    const patientId = randomUUID();
    await pool.query(
      `INSERT INTO patient_operational_records
        (id,clinic_id,private_display_name,preferred_locale)
       VALUES ($1,$2,$3,'fr')`,
      [patientId, ids.clinic, `Target ${index}`],
    );
    await pool.query(
      `INSERT INTO queue_entries
        (id,clinic_id,session_id,patient_id,state,source,registration_order)
       VALUES ($1,$2,$3,$4,'waiting','walk_in',$5)`,
      [randomUUID(), ids.clinic, ids.targetSession, patientId, index + 1],
    );
  }

  await insertDuration(pool, 10, 1);
  await insertDuration(pool, 12, 2);
});
afterAll(async () => pool.end());

describe('WU68 receptionist historical ETA snapshot', () => {
  it('never mixes a newly committed historical threshold/delay with the older dashboard snapshot', async () => {
    const firstQueryReached = deferred();
    const releaseFirstQuery = deferred();
    const service = new ReceptionistDashboardService(
      poolWithMainQueryBarrier(firstQueryReached, releaseFirstQuery),
    );

    const snapshotPromise = service.getSnapshot(scope, ids.targetSession);
    await firstQueryReached.promise;

    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await insertDuration(writer, 20, 3);
      await writer.query(
        `UPDATE consultation_sessions
            SET declared_delay_minutes=20, delay_version=delay_version+1, delay_updated_at=now()
          WHERE id=$1 AND clinic_id=$2`,
        [ids.targetSession, ids.clinic],
      );
      await writer.query('COMMIT');
    } catch (error) {
      await writer.query('ROLLBACK');
      throw error;
    } finally {
      writer.release();
    }
    releaseFirstQuery.resolve();

    const snapshot = await snapshotPromise;
    expect(snapshot.session.declaredDelayMinutes).toBeNull();
    expect(snapshot.entries[1]!.eta).toEqual({
      patientsAhead: 1,
      minWaitMinutes: 11,
      maxWaitMinutes: 23,
      estimatedConsultationMinutes: 15,
      estimateSource: 'fallback',
      revision: expect.stringMatching(/^eta-v1-[0-9a-f]{8}$/),
      observedSampleCount: 0,
    });

    const after = await new ReceptionistDashboardService(pool).getSnapshot(
      scope,
      ids.targetSession,
    );
    expect(after.session.declaredDelayMinutes).toBe(20);
    expect(after.entries[1]!.eta).toEqual({
      patientsAhead: 1,
      minWaitMinutes: 29,
      maxWaitMinutes: 38,
      estimatedConsultationMinutes: 12,
      estimateSource: 'historical_median',
      revision: expect.stringMatching(/^eta-v1-[0-9a-f]{8}$/),
      observedSampleCount: 0,
    });
  });
});
