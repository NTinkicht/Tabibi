import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppointmentService } from '@/modules/appointment';
import { AppointmentLifecycleService } from '@/modules/appointment/lifecycle';
import { AppointmentRecoveryService } from '@/modules/appointment/recovery';
import { QueueService } from '@/modules/queue';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  sourceSession: randomUUID(),
  targetSession: randomUUID(),
  patient: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE appointment_recovery_receipts,
    appointment_lifecycle_receipts, appointment_booking_receipts, appointments,
    audit_events, queue_command_receipts, queue_reorder_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'restore-race-reception','Reception'),($2,'restore-race-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'restore-race','Restore Race Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
      VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.receptionist],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr Race')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES
      ($1,$3,$4,'2026-09-18','2026-09-18 09:00Z','2026-09-18 12:00Z','open'),
      ($2,$3,$4,'2026-09-19','2026-09-19 09:00Z','2026-09-19 12:00Z','planned')`,
    [ids.sourceSession, ids.targetSession, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
      (id,clinic_id,private_display_name,preferred_locale)
      VALUES($1,$2,'Race Patient','fr')`,
    [ids.patient, ids.clinic],
  );
});
afterAll(async () => pool.end());

async function waitForLockWaiters(applicationName: string, expected: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text count
         FROM pg_stat_activity
        WHERE datname=current_database()
          AND application_name=$1
          AND wait_event_type='Lock'`,
      [applicationName],
    );
    if (Number(result.rows[0]?.count ?? 0) >= expected) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Expected ${expected} blocked command(s)`);
}

async function bookCancelled() {
  const booking = await new AppointmentService(pool).bookForExistingPatient(
    scope,
    ids.sourceSession,
    {
      patientId: ids.patient,
      scheduledStartAt: new Date('2026-09-18T09:30:00Z'),
      scheduledEndAt: new Date('2026-09-18T09:45:00Z'),
      contactPreference: 'none',
      idempotencyKey: 'rr-book',
      correlationId: 'rr-book',
    },
  );
  await new AppointmentLifecycleService(pool).command(
    scope,
    ids.sourceSession,
    booking.appointment.id,
    {
      command: 'cancel',
      reason: 'Initial cancellation',
      idempotencyKey: 'rr-initial-cancel',
      correlationId: 'rr-initial-cancel',
    },
  );
  return booking;
}

async function withSessionLockHeld<T>(
  body: (racePool: Pool, applicationName: string) => Promise<T>,
  release: (blocker: import('pg').PoolClient) => Promise<void>,
  sessionId: string,
) {
  const applicationName = `restore-race-${randomUUID()}`;
  const racePool = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: applicationName,
    max: 4,
  });
  const blocker = await racePool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      `SELECT id FROM consultation_sessions WHERE id=$1 AND clinic_id=$2 FOR UPDATE`,
      [sessionId, ids.clinic],
    );
    const result = await body(racePool, applicationName);
    await release(blocker);
    return result;
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
    await racePool.end();
  }
}

function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}

async function states(appointmentId: string, entryId: string) {
  const result = await pool.query<{
    appointment_status: string;
    queue_state: string;
    priority_order: string | null;
    session_id: string;
  }>(
    `SELECT a.status::text appointment_status, q.state::text queue_state,
            q.priority_order::text priority_order, q.session_id
       FROM appointments a JOIN queue_entries q ON q.id=$2
      WHERE a.id=$1`,
    [appointmentId, entryId],
  );
  return result.rows[0];
}

describe('restore and priority recovery races', () => {
  it('applies a restore queued ahead of a competing cancel, then the cancel', async () => {
    const booking = await bookCancelled();
    const outcome = await withSessionLockHeld(
      async (racePool, app) => {
        const restore = settle(
          new AppointmentRecoveryService(racePool).command(
            scope,
            ids.sourceSession,
            booking.appointment.id,
            {
              command: 'restore',
              reason: 'Restore wins the queue',
              idempotencyKey: 'rr-restore-first',
              correlationId: 'rr-restore-first',
            },
          ),
        );
        await waitForLockWaiters(app, 1);
        const cancel = settle(
          new AppointmentLifecycleService(racePool).command(
            scope,
            ids.sourceSession,
            booking.appointment.id,
            {
              command: 'cancel',
              reason: 'Competing cancel',
              idempotencyKey: 'rr-cancel-second',
              correlationId: 'rr-cancel-second',
            },
          ),
        );
        await waitForLockWaiters(app, 2);
        return { restore, cancel };
      },
      (blocker) => blocker.query('COMMIT').then(() => undefined),
      ids.sourceSession,
    );
    const { restore, cancel } = {
      restore: await outcome.restore,
      cancel: await outcome.cancel,
    };
    expect(restore.status).toBe('fulfilled');
    expect(cancel.status).toBe('fulfilled');
    expect(
      await states(booking.appointment.id, booking.entry.id),
    ).toMatchObject({
      appointment_status: 'cancelled',
      queue_state: 'cancelled',
      priority_order: null,
      session_id: ids.sourceSession,
    });
    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events
        WHERE entity_id=$1 AND action LIKE 'appointment.%' ORDER BY id`,
      [booking.appointment.id],
    );
    const actions = audit.rows.map((row) => row.action);
    expect(actions.indexOf('appointment.restore')).toBeGreaterThan(-1);
    expect(actions.indexOf('appointment.restore')).toBeLessThan(
      actions.lastIndexOf('appointment.cancel'),
    );
  });

  it('rejects a second restore queued behind a first restore that already restored the appointment', async () => {
    const booking = await bookCancelled();
    const outcome = await withSessionLockHeld(
      async (racePool, app) => {
        const first = settle(
          new AppointmentRecoveryService(racePool).command(
            scope,
            ids.sourceSession,
            booking.appointment.id,
            {
              command: 'restore',
              reason: 'First restore',
              idempotencyKey: 'rr-restore-a',
              correlationId: 'rr-restore-a',
            },
          ),
        );
        await waitForLockWaiters(app, 1);
        const second = settle(
          new AppointmentRecoveryService(racePool).command(
            scope,
            ids.sourceSession,
            booking.appointment.id,
            {
              command: 'restore',
              reason: 'Second restore with a different key',
              idempotencyKey: 'rr-restore-b',
              correlationId: 'rr-restore-b',
            },
          ),
        );
        await waitForLockWaiters(app, 2);
        return { first, second };
      },
      (blocker) => blocker.query('COMMIT').then(() => undefined),
      ids.sourceSession,
    );
    const { first, second } = {
      first: await outcome.first,
      second: await outcome.second,
    };
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(
      await states(booking.appointment.id, booking.entry.id),
    ).toMatchObject({
      appointment_status: 'confirmed',
      queue_state: 'waiting',
      session_id: ids.sourceSession,
    });
    const receipts = await pool.query<{ count: string }>(
      `SELECT count(*)::text count FROM appointment_recovery_receipts
        WHERE idempotency_key IN ('rr-restore-a','rr-restore-b')`,
    );
    expect(receipts.rows[0]?.count).toBe('1');
  });

  it('applies a cancel queued ahead of a restore of an active appointment, then restores it', async () => {
    const booking = await new AppointmentService(pool).bookForExistingPatient(
      scope,
      ids.sourceSession,
      {
        patientId: ids.patient,
        scheduledStartAt: new Date('2026-09-18T09:30:00Z'),
        scheduledEndAt: new Date('2026-09-18T09:45:00Z'),
        contactPreference: 'none',
        idempotencyKey: 'rr-book-cancel-first',
        correlationId: 'rr-book-cancel-first',
      },
    );
    const outcome = await withSessionLockHeld(
      async (racePool, app) => {
        const cancel = settle(
          new AppointmentLifecycleService(racePool).command(
            scope,
            ids.sourceSession,
            booking.appointment.id,
            {
              command: 'cancel',
              reason: 'Cancel wins the queue',
              idempotencyKey: 'rr-cancel-first',
              correlationId: 'rr-cancel-first',
            },
          ),
        );
        await waitForLockWaiters(app, 1);
        const restore = settle(
          new AppointmentRecoveryService(racePool).command(
            scope,
            ids.sourceSession,
            booking.appointment.id,
            {
              command: 'restore',
              reason: 'Restore queued behind the cancel',
              idempotencyKey: 'rr-restore-second',
              correlationId: 'rr-restore-second',
            },
          ),
        );
        await waitForLockWaiters(app, 2);
        return { cancel, restore };
      },
      (blocker) => blocker.query('COMMIT').then(() => undefined),
      ids.sourceSession,
    );
    expect((await outcome.cancel).status).toBe('fulfilled');
    expect((await outcome.restore).status).toBe('fulfilled');
    expect(
      await states(booking.appointment.id, booking.entry.id),
    ).toMatchObject({
      appointment_status: 'confirmed',
      queue_state: 'waiting',
      priority_order: null,
      session_id: ids.sourceSession,
    });
    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events
        WHERE entity_id=$1 AND action IN ('appointment.cancel','appointment.restore')
        ORDER BY id`,
      [booking.appointment.id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      'appointment.cancel',
      'appointment.restore',
    ]);
    const receipts = await pool.query<{ recovery: string; lifecycle: string }>(
      `SELECT
        (SELECT count(*)::text FROM appointment_recovery_receipts
          WHERE idempotency_key='rr-restore-second') recovery,
        (SELECT count(*)::text FROM appointment_lifecycle_receipts
          WHERE idempotency_key='rr-cancel-first') lifecycle`,
    );
    expect(receipts.rows[0]).toEqual({ recovery: '1', lifecycle: '1' });
  });

  it('rejects a priority insert queued behind a transfer of the same entry without leaving priority state', async () => {
    const booking = await new AppointmentService(pool).bookForExistingPatient(
      scope,
      ids.sourceSession,
      {
        patientId: ids.patient,
        scheduledStartAt: new Date('2026-09-18T09:30:00Z'),
        scheduledEndAt: new Date('2026-09-18T09:45:00Z'),
        contactPreference: 'none',
        idempotencyKey: 'rr-book-priority',
        correlationId: 'rr-book-priority',
      },
    );
    const version = await pool.query<{ v: string }>(
      `SELECT queue_order_version::text v FROM consultation_sessions WHERE id=$1`,
      [ids.sourceSession],
    );
    const outcome = await withSessionLockHeld(
      async (racePool, app) => {
        const transfer = settle(
          new AppointmentRecoveryService(racePool).command(
            scope,
            ids.sourceSession,
            booking.appointment.id,
            {
              command: 'transfer',
              reason: 'Transfer wins the queue',
              targetSessionId: ids.targetSession,
              idempotencyKey: 'rr-transfer-first',
              correlationId: 'rr-transfer-first',
            },
          ),
        );
        await waitForLockWaiters(app, 1);
        const insert = settle(
          new QueueService(racePool).reorder(
            scope,
            ids.sourceSession,
            booking.entry.id,
            {
              targetPosition: 1,
              expectedVersion: Number(version.rows[0]?.v),
              idempotencyKey: 'rr-priority-second',
              reason: 'Competing priority insert',
              correlationId: 'rr-priority-second',
            },
          ),
        );
        await waitForLockWaiters(app, 2);
        return { transfer, insert };
      },
      (blocker) => blocker.query('COMMIT').then(() => undefined),
      ids.sourceSession,
    );
    const { transfer, insert } = {
      transfer: await outcome.transfer,
      insert: await outcome.insert,
    };
    expect(transfer.status).toBe('fulfilled');
    expect(insert.status).toBe('rejected');
    const source = await pool.query<{
      state: string;
      priority_order: string | null;
    }>(
      `SELECT state::text, priority_order::text FROM queue_entries WHERE id=$1`,
      [booking.entry.id],
    );
    expect(source.rows[0]).toEqual({
      state: 'cancelled',
      priority_order: null,
    });
    const priorities = await pool.query<{ count: string }>(
      `SELECT count(*)::text count FROM queue_entries WHERE priority_order IS NOT NULL`,
    );
    expect(priorities.rows[0]?.count).toBe('0');
    const receipts = await pool.query<{ count: string }>(
      `SELECT count(*)::text count FROM queue_reorder_receipts
        WHERE idempotency_key='rr-priority-second'`,
    );
    expect(receipts.rows[0]?.count).toBe('0');
  });

  it('rejects a call queued ahead of restore_and_check_in of a cancelled entry, then checks the entry in', async () => {
    const booking = await bookCancelled();
    const outcome = await withSessionLockHeld(
      async (racePool, app) => {
        const call = settle(
          new QueueService(racePool).command(
            scope,
            ids.sourceSession,
            booking.entry.id,
            {
              command: 'call',
              idempotencyKey: 'rr-call-first',
              correlationId: 'rr-call-first',
            },
          ),
        );
        await waitForLockWaiters(app, 1);
        const restore = settle(
          new AppointmentRecoveryService(racePool).command(
            scope,
            ids.sourceSession,
            booking.appointment.id,
            {
              command: 'restore_and_check_in',
              reason: 'Restore queued behind the call',
              idempotencyKey: 'rr-restore-after-call',
              correlationId: 'rr-restore-after-call',
            },
          ),
        );
        await waitForLockWaiters(app, 2);
        return { call, restore };
      },
      (blocker) => blocker.query('COMMIT').then(() => undefined),
      ids.sourceSession,
    );
    expect((await outcome.call).status).toBe('rejected');
    expect((await outcome.restore).status).toBe('fulfilled');
    expect(
      await states(booking.appointment.id, booking.entry.id),
    ).toMatchObject({
      queue_state: 'checked_in',
      priority_order: null,
      session_id: ids.sourceSession,
    });
    const leftovers = await pool.query<{ called: string; receipts: string }>(
      `SELECT
        (SELECT count(*)::text FROM queue_entries
          WHERE session_id=$1 AND state='called') called,
        (SELECT count(*)::text FROM queue_command_receipts
          WHERE idempotency_key='rr-call-first') receipts`,
      [ids.sourceSession],
    );
    expect(leftovers.rows[0]).toEqual({ called: '0', receipts: '0' });
  });

  it('calls the entry once restore_and_check_in queued ahead of the call has made it callable', async () => {
    const booking = await bookCancelled();
    const outcome = await withSessionLockHeld(
      async (racePool, app) => {
        const restore = settle(
          new AppointmentRecoveryService(racePool).command(
            scope,
            ids.sourceSession,
            booking.appointment.id,
            {
              command: 'restore_and_check_in',
              reason: 'Restore wins the queue',
              idempotencyKey: 'rr-restore-before-call',
              correlationId: 'rr-restore-before-call',
            },
          ),
        );
        await waitForLockWaiters(app, 1);
        const call = settle(
          new QueueService(racePool).command(
            scope,
            ids.sourceSession,
            booking.entry.id,
            {
              command: 'call',
              idempotencyKey: 'rr-call-second',
              correlationId: 'rr-call-second',
            },
          ),
        );
        await waitForLockWaiters(app, 2);
        return { restore, call };
      },
      (blocker) => blocker.query('COMMIT').then(() => undefined),
      ids.sourceSession,
    );
    expect((await outcome.restore).status).toBe('fulfilled');
    expect((await outcome.call).status).toBe('fulfilled');
    expect(
      await states(booking.appointment.id, booking.entry.id),
    ).toMatchObject({ queue_state: 'called', session_id: ids.sourceSession });
    const receipts = await pool.query<{ count: string }>(
      `SELECT count(*)::text count FROM queue_command_receipts
        WHERE idempotency_key='rr-call-second'`,
    );
    expect(receipts.rows[0]?.count).toBe('1');
  });
});
