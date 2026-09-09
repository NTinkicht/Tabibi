import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppointmentService } from '@/modules/appointment';
import { AppointmentLifecycleService } from '@/modules/appointment/lifecycle';
import { AppointmentRecoveryService } from '@/modules/appointment/recovery';
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
      ($1,'wu14-race-reception','Reception'),($2,'wu14-race-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'wu14-race','WU14 Race Clinic')`,
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
  throw new Error(`Expected ${expected} blocked WU14 command(s)`);
}

describe('WU14 deterministic recovery races', () => {
  it('serializes transfer ahead of a queued cancellation without split state', async () => {
    const booking = await new AppointmentService(pool).bookForExistingPatient(
      scope,
      ids.sourceSession,
      {
        patientId: ids.patient,
        scheduledStartAt: new Date('2026-09-18T09:30:00Z'),
        scheduledEndAt: new Date('2026-09-18T09:45:00Z'),
        contactPreference: 'none',
        idempotencyKey: 'wu14-race-book',
        correlationId: 'wu14-race-book',
      },
    );

    const applicationName = `wu14-transfer-race-${randomUUID()}`;
    const racePool = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: applicationName,
      max: 4,
    });
    const blocker = await racePool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT id FROM consultation_sessions
          WHERE id=$1 AND clinic_id=$2 FOR UPDATE`,
        [ids.sourceSession, ids.clinic],
      );

      const transferPromise = new AppointmentRecoveryService(racePool).command(
        scope,
        ids.sourceSession,
        booking.appointment.id,
        {
          command: 'transfer',
          reason: 'Deterministic transfer winner',
          targetSessionId: ids.targetSession,
          idempotencyKey: 'wu14-race-transfer',
          correlationId: 'wu14-race-transfer',
        },
      );
      await waitForLockWaiters(applicationName, 1);

      const cancelPromise = new AppointmentLifecycleService(racePool).command(
        scope,
        ids.sourceSession,
        booking.appointment.id,
        {
          command: 'cancel',
          reason: 'Queued competing cancellation',
          idempotencyKey: 'wu14-race-cancel',
          correlationId: 'wu14-race-cancel',
        },
      );
      await waitForLockWaiters(applicationName, 2);
      await blocker.query('COMMIT');

      const [transfer, cancel] = await Promise.allSettled([
        transferPromise,
        cancelPromise,
      ]);
      expect(transfer.status).toBe('fulfilled');
      expect(cancel.status).toBe('rejected');

      const state = await pool.query<{
        appointment_session: string;
        appointment_status: string;
        queue_state: string;
        source_state: string;
      }>(
        `SELECT appointment.session_id appointment_session,
                appointment.status::text appointment_status,
                target.state::text queue_state,
                source.state::text source_state
           FROM appointments appointment
           JOIN queue_entries target ON target.id=appointment.queue_entry_id
           JOIN queue_entries source ON source.id=$2
          WHERE appointment.id=$1`,
        [booking.appointment.id, booking.entry.id],
      );
      expect(state.rows[0]).toEqual({
        appointment_session: ids.targetSession,
        appointment_status: 'confirmed',
        queue_state: 'waiting',
        source_state: 'cancelled',
      });
      const receipts = await pool.query<{
        recovery: string;
        lifecycle: string;
        targets: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM appointment_recovery_receipts
            WHERE idempotency_key='wu14-race-transfer') recovery,
          (SELECT count(*)::text FROM appointment_lifecycle_receipts
            WHERE idempotency_key='wu14-race-cancel') lifecycle,
          (SELECT count(*)::text FROM queue_entries
            WHERE session_id=$1 AND patient_id=$2) targets`,
        [ids.targetSession, ids.patient],
      );
      expect(receipts.rows[0]).toEqual({
        recovery: '1',
        lifecycle: '0',
        targets: '1',
      });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await racePool.end();
    }
  });
});
