import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AppointmentConflictError,
  AppointmentService,
} from '@/modules/appointment';
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
  secondPatient: randomUUID(),
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
      ($1,'wu14-reception','Reception'),($2,'wu14-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'wu14','WU14 Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
      VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.receptionist],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr WU14')`,
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
      ($1,$3,$4,'2026-09-16','2026-09-16 09:00Z','2026-09-16 12:00Z','open'),
      ($2,$3,$4,'2026-09-17','2026-09-17 09:00Z','2026-09-17 12:00Z','planned')`,
    [ids.sourceSession, ids.targetSession, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
      (id,clinic_id,private_display_name,preferred_locale)
      VALUES ($1,$3,'WU14 Patient','fr'),($2,$3,'WU14 Second','ar')`,
    [ids.patient, ids.secondPatient, ids.clinic],
  );
});
afterAll(async () => pool.end());

async function book(
  patientId = ids.patient,
  sessionId = ids.sourceSession,
  key: string = randomUUID(),
) {
  return new AppointmentService(pool).bookForExistingPatient(scope, sessionId, {
    patientId,
    scheduledStartAt: new Date(
      sessionId === ids.sourceSession
        ? '2026-09-16T09:30:00Z'
        : '2026-09-17T09:30:00Z',
    ),
    scheduledEndAt: new Date(
      sessionId === ids.sourceSession
        ? '2026-09-16T09:45:00Z'
        : '2026-09-17T09:45:00Z',
    ),
    contactPreference: 'none',
    idempotencyKey: key,
    correlationId: key,
  });
}

async function checkIn(appointmentId: string, key: string = randomUUID()) {
  return new AppointmentLifecycleService(pool).command(
    scope,
    ids.sourceSession,
    appointmentId,
    { command: 'check_in', idempotencyKey: key, correlationId: key },
  );
}

async function pairedState(appointmentId: string) {
  const result = await pool.query<{
    appointment_id: string;
    appointment_status: string;
    session_id: string;
    queue_entry_id: string;
    queue_state: string;
    eligibility_order: string | null;
    priority_order: string | null;
  }>(
    `SELECT appointment.id appointment_id,
            appointment.status::text appointment_status,
            appointment.session_id,
            appointment.queue_entry_id,
            entry.state::text queue_state,
            entry.eligibility_order,
            entry.priority_order
       FROM appointments appointment
       JOIN queue_entries entry ON entry.id=appointment.queue_entry_id
      WHERE appointment.id=$1`,
    [appointmentId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected appointment pair to exist');
  return row;
}

describe('WU14 appointment restore and transfer synchronization', () => {
  it('ordinary restore always returns a prior checked-in cancellation to confirmed/waiting and retries exactly', async () => {
    const booking = await book(
      ids.patient,
      ids.sourceSession,
      'wu14-restore-book',
    );
    await checkIn(booking.appointment.id, 'wu14-restore-check-in');
    await new AppointmentLifecycleService(pool).command(
      scope,
      ids.sourceSession,
      booking.appointment.id,
      {
        command: 'cancel',
        reason: 'Mistaken cancellation',
        idempotencyKey: 'wu14-restore-cancel',
        correlationId: 'wu14-restore-cancel',
      },
    );

    const recovery = new AppointmentRecoveryService(pool);
    const input = {
      command: 'restore' as const,
      reason: 'Undo mistaken terminal state',
      idempotencyKey: 'wu14-restore',
      correlationId: 'wu14-restore',
    };
    const first = await recovery.command(
      scope,
      ids.sourceSession,
      booking.appointment.id,
      input,
    );
    const retry = await recovery.command(
      scope,
      ids.sourceSession,
      booking.appointment.id,
      input,
    );

    expect(retry).toEqual(first);
    expect(first.appointment.status).toBe('confirmed');
    expect(first.entry.state).toBe('waiting');
    expect(await pairedState(booking.appointment.id)).toMatchObject({
      appointment_status: 'confirmed',
      queue_state: 'waiting',
      eligibility_order: null,
      priority_order: null,
    });
    const evidence = await pool.query<{ audits: string; receipts: string }>(
      `SELECT
        (SELECT count(*)::text FROM audit_events
          WHERE entity_id=$1 AND action='appointment.restore') audits,
        (SELECT count(*)::text FROM appointment_recovery_receipts
          WHERE appointment_id=$1 AND command='restore') receipts`,
      [booking.appointment.id],
    );
    expect(evidence.rows[0]).toEqual({ audits: '1', receipts: '1' });
  });

  it('restore_and_check_in explicitly returns a no-show to checked-in at a fresh tail', async () => {
    const first = await book(
      ids.secondPatient,
      ids.sourceSession,
      'wu14-tail-book',
    );
    await checkIn(first.appointment.id, 'wu14-tail-check-in');
    const booking = await book(
      ids.patient,
      ids.sourceSession,
      'wu14-raci-book',
    );
    await checkIn(booking.appointment.id, 'wu14-raci-check-in');
    await new AppointmentLifecycleService(pool).command(
      scope,
      ids.sourceSession,
      booking.appointment.id,
      {
        command: 'no_show',
        reason: 'Mistaken no-show',
        idempotencyKey: 'wu14-raci-no-show',
        correlationId: 'wu14-raci-no-show',
      },
    );

    const result = await new AppointmentRecoveryService(pool).command(
      scope,
      ids.sourceSession,
      booking.appointment.id,
      {
        command: 'restore_and_check_in',
        reason: 'Patient is physically present',
        idempotencyKey: 'wu14-raci',
        correlationId: 'wu14-raci',
      },
    );
    expect(result.appointment.status).toBe('checked_in');
    expect(result.entry.state).toBe('checked_in');
    const state = await pairedState(booking.appointment.id);
    expect(Number(state.eligibility_order)).toBeGreaterThan(1);
    expect(state.priority_order).toBeNull();
  });

  it.each([
    {
      appointmentStatus: 'cancelled',
      queueState: 'no_show',
      suffix: 'cancelled-no-show',
    },
    {
      appointmentStatus: 'no_show',
      queueState: 'cancelled',
      suffix: 'no-show-cancelled',
    },
  ] as const)(
    'rejects mismatched terminal pair $appointmentStatus/$queueState without recovery side effects',
    async ({ appointmentStatus, queueState, suffix }) => {
      const booking = await book(
        ids.patient,
        ids.sourceSession,
        `wu14-mismatch-book-${suffix}`,
      );
      await checkIn(booking.appointment.id, `wu14-mismatch-check-in-${suffix}`);
      await new AppointmentLifecycleService(pool).command(
        scope,
        ids.sourceSession,
        booking.appointment.id,
        {
          command: queueState === 'no_show' ? 'no_show' : 'cancel',
          reason: 'Prepare terminal state mismatch',
          idempotencyKey: `wu14-mismatch-terminal-${suffix}`,
          correlationId: `wu14-mismatch-terminal-${suffix}`,
        },
      );
      await pool.query(
        `UPDATE appointments
            SET status=$2::appointment_status
          WHERE id=$1`,
        [booking.appointment.id, appointmentStatus],
      );

      const snapshot = async () => {
        const result = await pool.query<{
          appointment_status: string;
          queue_state: string;
          registration_order: string;
          eligibility_order: string | null;
          priority_order: string | null;
          queue_order_version: string;
          audit_count: string;
          receipt_count: string;
        }>(
          `SELECT appointment.status::text appointment_status,
                  entry.state::text queue_state,
                  entry.registration_order,
                  entry.eligibility_order,
                  entry.priority_order,
                  session.queue_order_version,
                  (SELECT count(*)::text FROM audit_events
                    WHERE entity_id=appointment.id) audit_count,
                  (SELECT count(*)::text FROM appointment_recovery_receipts
                    WHERE appointment_id=appointment.id) receipt_count
             FROM appointments appointment
             JOIN queue_entries entry ON entry.id=appointment.queue_entry_id
             JOIN consultation_sessions session ON session.id=appointment.session_id
            WHERE appointment.id=$1`,
          [booking.appointment.id],
        );
        return result.rows[0];
      };
      const before = await snapshot();

      await expect(
        new AppointmentRecoveryService(pool).command(
          scope,
          ids.sourceSession,
          booking.appointment.id,
          {
            command: 'restore',
            reason: 'Must reject a split terminal pair',
            idempotencyKey: `wu14-mismatch-restore-${suffix}`,
            correlationId: `wu14-mismatch-restore-${suffix}`,
          },
        ),
      ).rejects.toBeInstanceOf(AppointmentConflictError);

      expect(before).toMatchObject({
        appointment_status: appointmentStatus,
        queue_state: queueState,
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it('transfers a waiting appointment without changing identity and exact retry creates one target', async () => {
    const booking = await book(
      ids.patient,
      ids.sourceSession,
      'wu14-transfer-book',
    );
    const recovery = new AppointmentRecoveryService(pool);
    const input = {
      command: 'transfer' as const,
      reason: 'Move to next session',
      targetSessionId: ids.targetSession,
      idempotencyKey: 'wu14-transfer',
      correlationId: 'wu14-transfer',
    };
    const first = await recovery.command(
      scope,
      ids.sourceSession,
      booking.appointment.id,
      input,
    );
    const retry = await recovery.command(
      scope,
      ids.sourceSession,
      booking.appointment.id,
      input,
    );

    expect(retry).toEqual(first);
    expect(first.appointment.id).toBe(booking.appointment.id);
    expect(first.appointment.sessionId).toBe(ids.targetSession);
    expect(first.entry.state).toBe('waiting');
    const source = await pool.query<{ state: string }>(
      'SELECT state::text state FROM queue_entries WHERE id=$1',
      [booking.entry.id],
    );
    expect(source.rows[0]?.state).toBe('cancelled');
    const targets = await pool.query<{ count: string }>(
      `SELECT count(*)::text count FROM queue_entries
        WHERE session_id=$1 AND patient_id=$2 AND source='appointment'`,
      [ids.targetSession, ids.patient],
    );
    expect(targets.rows[0]?.count).toBe('1');
  });

  it('transfers a prioritized checked-in entry and compacts the source priority cohort', async () => {
    const transferred = await book(
      ids.patient,
      ids.sourceSession,
      'wu14-priority-transfer',
    );
    const remaining = await book(
      ids.secondPatient,
      ids.sourceSession,
      'wu14-priority-remain',
    );
    await checkIn(transferred.appointment.id, 'wu14-priority-transfer-ci');
    await checkIn(remaining.appointment.id, 'wu14-priority-remain-ci');
    await pool.query(
      `UPDATE queue_entries
          SET priority_order=CASE
            WHEN id=$1 THEN 1
            WHEN id=$2 THEN 2
            ELSE priority_order
          END
        WHERE id=ANY($3::uuid[])`,
      [
        transferred.entry.id,
        remaining.entry.id,
        [transferred.entry.id, remaining.entry.id],
      ],
    );

    const result = await new AppointmentRecoveryService(pool).command(
      scope,
      ids.sourceSession,
      transferred.appointment.id,
      {
        command: 'transfer',
        reason: 'Transfer prioritized arrival',
        targetSessionId: ids.targetSession,
        idempotencyKey: 'wu14-priority-move',
        correlationId: 'wu14-priority-move',
      },
    );
    expect(result.entry.state).toBe('checked_in');
    const remainingState = await pool.query<{ priority_order: string | null }>(
      'SELECT priority_order FROM queue_entries WHERE id=$1',
      [remaining.entry.id],
    );
    expect(remainingState.rows[0]?.priority_order).toBe('1');
    const moved = await pairedState(transferred.appointment.id);
    expect(moved.priority_order).toBeNull();
    expect(Number(moved.eligibility_order)).toBeGreaterThan(0);
  });

  it('rejects an existing target-session appointment before any source mutation', async () => {
    const source = await book(
      ids.patient,
      ids.sourceSession,
      'wu14-conflict-source',
    );
    await book(ids.patient, ids.targetSession, 'wu14-conflict-target');

    await expect(
      new AppointmentRecoveryService(pool).command(
        scope,
        ids.sourceSession,
        source.appointment.id,
        {
          command: 'transfer',
          reason: 'Would collide',
          targetSessionId: ids.targetSession,
          idempotencyKey: 'wu14-target-conflict',
          correlationId: 'wu14-target-conflict',
        },
      ),
    ).rejects.toThrow(
      'Patient already has an appointment in the target session',
    );
    expect(await pairedState(source.appointment.id)).toMatchObject({
      session_id: ids.sourceSession,
      queue_entry_id: source.entry.id,
      queue_state: 'waiting',
    });
  });

  it('rolls back source terminalization if target insertion fails after mutation', async () => {
    const booking = await book(
      ids.patient,
      ids.sourceSession,
      'wu14-rollback-book',
    );
    await pool.query(`CREATE FUNCTION wu14_fail_target_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.session_id='${ids.targetSession}'::uuid THEN
          RAISE EXCEPTION 'forced target insert failure';
        END IF;
        RETURN NEW;
      END;
      $$`);
    await pool.query(`CREATE TRIGGER wu14_fail_target_insert_trigger
      BEFORE INSERT ON queue_entries FOR EACH ROW
      EXECUTE FUNCTION wu14_fail_target_insert()`);
    try {
      await expect(
        new AppointmentRecoveryService(pool).command(
          scope,
          ids.sourceSession,
          booking.appointment.id,
          {
            command: 'transfer',
            reason: 'Rollback proof',
            targetSessionId: ids.targetSession,
            idempotencyKey: 'wu14-rollback',
            correlationId: 'wu14-rollback',
          },
        ),
      ).rejects.toThrow('forced target insert failure');
    } finally {
      await pool.query(
        'DROP TRIGGER IF EXISTS wu14_fail_target_insert_trigger ON queue_entries',
      );
      await pool.query('DROP FUNCTION IF EXISTS wu14_fail_target_insert()');
    }
    expect(await pairedState(booking.appointment.id)).toMatchObject({
      session_id: ids.sourceSession,
      queue_entry_id: booking.entry.id,
      queue_state: 'waiting',
    });
    const evidence = await pool.query<{ targets: string; receipts: string }>(
      `SELECT
        (SELECT count(*)::text FROM queue_entries
          WHERE session_id=$1 AND patient_id=$2) targets,
        (SELECT count(*)::text FROM appointment_recovery_receipts
          WHERE idempotency_key='wu14-rollback') receipts`,
      [ids.targetSession, ids.patient],
    );
    expect(evidence.rows[0]).toEqual({ targets: '0', receipts: '0' });
  });

  it('rejects stale source linkage after a successful prior transfer', async () => {
    const booking = await book(
      ids.patient,
      ids.sourceSession,
      'wu14-stale-book',
    );
    await new AppointmentRecoveryService(pool).command(
      scope,
      ids.sourceSession,
      booking.appointment.id,
      {
        command: 'transfer',
        reason: 'Initial transfer',
        targetSessionId: ids.targetSession,
        idempotencyKey: 'wu14-stale-first',
        correlationId: 'wu14-stale-first',
      },
    );
    await expect(
      new AppointmentRecoveryService(pool).command(
        scope,
        ids.sourceSession,
        booking.appointment.id,
        {
          command: 'transfer',
          reason: 'Stale source retry with new key',
          targetSessionId: ids.targetSession,
          idempotencyKey: 'wu14-stale-second',
          correlationId: 'wu14-stale-second',
        },
      ),
    ).rejects.toBeInstanceOf(AppointmentConflictError);
  });

  it('rejects a target session outside the authenticated clinic without side effects', async () => {
    const otherClinic = randomUUID();
    const otherUser = randomUUID();
    const otherDoctor = randomUUID();
    const otherSession = randomUUID();
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'wu14-other','Other')`,
      [otherUser],
    );
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'wu14-other','Other Clinic')`,
      [otherClinic],
    );
    await pool.query(
      `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Other Doctor')`,
      [otherDoctor, otherUser],
    );
    await pool.query(
      `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
      [otherClinic, otherDoctor],
    );
    await pool.query(
      `INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
       VALUES($1,$2,$3,'2026-09-17','2026-09-17 09:00Z','2026-09-17 12:00Z','open')`,
      [otherSession, otherClinic, otherDoctor],
    );
    const booking = await book(
      ids.patient,
      ids.sourceSession,
      'wu14-tenant-book',
    );
    await expect(
      new AppointmentRecoveryService(pool).command(
        scope,
        ids.sourceSession,
        booking.appointment.id,
        {
          command: 'transfer',
          reason: 'Cross clinic attempt',
          targetSessionId: otherSession,
          idempotencyKey: 'wu14-tenant',
          correlationId: 'wu14-tenant',
        },
      ),
    ).rejects.toThrow('Recovery session was not found in this clinic');
    expect(await pairedState(booking.appointment.id)).toMatchObject({
      session_id: ids.sourceSession,
      queue_state: 'waiting',
    });
  });
});
