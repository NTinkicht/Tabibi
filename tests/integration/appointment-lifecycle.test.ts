import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AppointmentConflictError,
  AppointmentService,
} from '@/modules/appointment';
import { AppointmentLifecycleService } from '@/modules/appointment/lifecycle';
import { SessionService } from '@/modules/session';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  patient: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE appointment_lifecycle_receipts,
    appointment_booking_receipts, appointments, audit_events,
    queue_command_receipts, queue_reorder_receipts, queue_registration_receipts,
    queue_entries, patient_operational_records, session_command_receipts,
    consultation_sessions, schedule_templates, doctor_clinics, doctor_profiles,
    clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'wu12-reception','Reception'),($2,'wu12-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'wu12','WU12 Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
      VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.receptionist],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr WU12')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES($1,$2,$3,'2026-09-15','2026-09-15 09:00Z','2026-09-15 12:00Z','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
      (id,clinic_id,private_display_name,preferred_locale)
      VALUES($1,$2,'WU12 Patient','fr')`,
    [ids.patient, ids.clinic],
  );
});
afterAll(async () => pool.end());

async function book(key = 'wu12-book') {
  return new AppointmentService(pool).bookForExistingPatient(
    scope,
    ids.session,
    {
      patientId: ids.patient,
      scheduledStartAt: new Date('2026-09-15T09:30:00Z'),
      scheduledEndAt: new Date('2026-09-15T09:45:00Z'),
      contactPreference: 'none',
      idempotencyKey: key,
      correlationId: key,
    },
  );
}

describe('WU12 appointment lifecycle synchronization', () => {
  it('checks in appointment and linked queue atomically and makes exact retry side-effect free', async () => {
    const booking = await book();
    const lifecycle = new AppointmentLifecycleService(pool);
    const input = {
      command: 'check_in' as const,
      idempotencyKey: 'wu12-check-in',
      correlationId: 'wu12-check-in',
    };
    const first = await lifecycle.command(
      scope,
      ids.session,
      booking.appointment.id,
      input,
    );
    const retry = await lifecycle.command(
      scope,
      ids.session,
      booking.appointment.id,
      input,
    );

    expect(retry).toEqual(first);
    expect(first.appointment.status).toBe('checked_in');
    expect(first.entry.state).toBe('checked_in');
    const evidence = await pool.query<{ audits: string; receipts: string }>(
      `SELECT
        (SELECT count(*)::text FROM audit_events WHERE entity_id=$1 AND action='appointment.check_in') audits,
        (SELECT count(*)::text FROM appointment_lifecycle_receipts WHERE appointment_id=$1) receipts`,
      [booking.appointment.id],
    );
    expect(evidence.rows[0]).toEqual({ audits: '1', receipts: '1' });
  });

  it('cancels appointment and linked queue atomically and rejects later resurrection', async () => {
    const booking = await book();
    const lifecycle = new AppointmentLifecycleService(pool);
    await lifecycle.command(scope, ids.session, booking.appointment.id, {
      command: 'cancel',
      reason: 'Patient requested cancellation',
      idempotencyKey: 'wu12-cancel',
      correlationId: 'wu12-cancel',
    });
    const states = await pool.query<{ appointment: string; entry: string }>(
      `SELECT appointment.status::text appointment, entry.state::text entry
         FROM appointments appointment
         JOIN queue_entries entry ON entry.id=appointment.queue_entry_id
        WHERE appointment.id=$1`,
      [booking.appointment.id],
    );
    expect(states.rows[0]).toEqual({
      appointment: 'cancelled',
      entry: 'cancelled',
    });
    await expect(
      lifecycle.command(scope, ids.session, booking.appointment.id, {
        command: 'check_in',
        idempotencyKey: 'wu12-resurrect',
        correlationId: 'wu12-resurrect',
      }),
    ).rejects.toBeInstanceOf(AppointmentConflictError);
  });

  it('serializes simultaneous cancel/check-in without split state', async () => {
    const booking = await book();
    const lifecycle = new AppointmentLifecycleService(pool);
    const results = await Promise.allSettled([
      lifecycle.command(scope, ids.session, booking.appointment.id, {
        command: 'check_in',
        idempotencyKey: 'wu12-race-checkin',
        correlationId: 'wu12-race-checkin',
      }),
      lifecycle.command(scope, ids.session, booking.appointment.id, {
        command: 'cancel',
        reason: 'Concurrent cancellation',
        idempotencyKey: 'wu12-race-cancel',
        correlationId: 'wu12-race-cancel',
      }),
    ]);

    const [checkIn, cancel] = results;
    expect(results.some((item) => item.status === 'fulfilled')).toBe(true);
    for (const result of results) {
      if (result.status === 'rejected')
        expect(result.reason).toBeInstanceOf(AppointmentConflictError);
    }

    const states = await pool.query<{ appointment: string; entry: string }>(
      `SELECT appointment.status::text appointment, entry.state::text entry
         FROM appointments appointment
         JOIN queue_entries entry ON entry.id=appointment.queue_entry_id
        WHERE appointment.id=$1`,
      [booking.appointment.id],
    );
    const finalState = states.rows[0]!;
    expect([
      { appointment: 'checked_in', entry: 'checked_in' },
      { appointment: 'cancelled', entry: 'cancelled' },
    ]).toContainEqual(finalState);

    if (finalState.appointment === 'checked_in') {
      expect(checkIn.status).toBe('fulfilled');
      expect(cancel.status).toBe('rejected');
    } else {
      expect(cancel.status).toBe('fulfilled');
    }
  });

  it('serializes appointment mutation against session terminalization without split state', async () => {
    const booking = await book();
    const lifecycle = new AppointmentLifecycleService(pool);
    const sessions = new SessionService(pool);
    await Promise.allSettled([
      lifecycle.command(scope, ids.session, booking.appointment.id, {
        command: 'check_in',
        idempotencyKey: 'wu12-session-race-checkin',
        correlationId: 'wu12-session-race-checkin',
      }),
      sessions.command(scope, ids.session, {
        command: 'cancel',
        reason: 'Clinic closure',
        idempotencyKey: 'wu12-session-cancel',
        correlationId: 'wu12-session-cancel',
      }),
    ]);
    const states = await pool.query<{
      session: string;
      appointment: string;
      entry: string;
    }>(
      `SELECT session.status::text session,
              appointment.status::text appointment,
              entry.state::text entry
         FROM consultation_sessions session
         JOIN appointments appointment ON appointment.session_id=session.id
         JOIN queue_entries entry ON entry.id=appointment.queue_entry_id
        WHERE appointment.id=$1`,
      [booking.appointment.id],
    );
    const row = states.rows[0]!;
    if (row.session === 'cancelled')
      expect(row).toMatchObject({
        appointment: 'cancelled',
        entry: 'cancelled',
      });
    else
      expect(row).toMatchObject({
        session: 'open',
        appointment: 'checked_in',
        entry: 'checked_in',
      });
  });
});

describe('WU13 appointment terminal lifecycle synchronization', () => {
  async function checkIn(appointmentId: string, suffix: string) {
    return new AppointmentLifecycleService(pool).command(
      scope,
      ids.session,
      appointmentId,
      {
        command: 'check_in',
        idempotencyKey: `wu13-check-in-${suffix}`,
        correlationId: `wu13-check-in-${suffix}`,
      },
    );
  }

  async function pairedState(appointmentId: string) {
    const result = await pool.query<{
      appointment: string;
      entry: string;
      completed_at: Date | null;
    }>(
      `SELECT appointment.status::text appointment,
              entry.state::text entry,
              entry.completed_at
         FROM appointments appointment
         JOIN queue_entries entry ON entry.id=appointment.queue_entry_id
        WHERE appointment.id=$1`,
      [appointmentId],
    );
    return result.rows[0]!;
  }

  it('maps no-show to both records and makes the exact retry side-effect free', async () => {
    const booking = await book('wu13-no-show-book');
    await checkIn(booking.appointment.id, 'no-show');
    const lifecycle = new AppointmentLifecycleService(pool);
    const input = {
      command: 'no_show' as const,
      reason: 'Patient absent after verified arrival workflow',
      idempotencyKey: 'wu13-no-show',
      correlationId: 'wu13-no-show',
    };

    const first = await lifecycle.command(
      scope,
      ids.session,
      booking.appointment.id,
      input,
    );
    const retry = await lifecycle.command(
      scope,
      ids.session,
      booking.appointment.id,
      input,
    );

    expect(retry).toEqual(first);
    expect(await pairedState(booking.appointment.id)).toMatchObject({
      appointment: 'no_show',
      entry: 'no_show',
    });
    const evidence = await pool.query<{ audits: string; receipts: string }>(
      `SELECT
        (SELECT count(*)::text FROM audit_events WHERE entity_id=$1 AND action='appointment.no_show') audits,
        (SELECT count(*)::text FROM appointment_lifecycle_receipts WHERE appointment_id=$1 AND command='no_show') receipts`,
      [booking.appointment.id],
    );
    expect(evidence.rows[0]).toEqual({ audits: '1', receipts: '1' });
  });

  it('maps consultation completion, records completion time, and retries exactly', async () => {
    const booking = await book('wu13-complete-book');
    await checkIn(booking.appointment.id, 'complete');
    await pool.query(
      `UPDATE queue_entries
          SET state='in_consultation', in_consultation_started_at=now()
        WHERE id=$1`,
      [booking.entry.id],
    );
    const lifecycle = new AppointmentLifecycleService(pool);
    const input = {
      command: 'complete_consultation' as const,
      idempotencyKey: 'wu13-complete',
      correlationId: 'wu13-complete',
    };

    const first = await lifecycle.command(
      scope,
      ids.session,
      booking.appointment.id,
      input,
    );
    expect(
      await lifecycle.command(
        scope,
        ids.session,
        booking.appointment.id,
        input,
      ),
    ).toEqual(first);
    expect(await pairedState(booking.appointment.id)).toEqual({
      appointment: 'completed',
      entry: 'completed',
      completed_at: expect.any(Date),
    });
    const evidence = await pool.query<{ audits: string; receipts: string }>(
      `SELECT
        (SELECT count(*)::text FROM audit_events WHERE entity_id=$1 AND action='appointment.complete_consultation') audits,
        (SELECT count(*)::text FROM appointment_lifecycle_receipts WHERE appointment_id=$1 AND command='complete_consultation') receipts`,
      [booking.appointment.id],
    );
    expect(evidence.rows[0]).toEqual({ audits: '1', receipts: '1' });
  });

  it('serializes conflicting terminal commands without a mismatched pair', async () => {
    const booking = await book('wu13-terminal-race-book');
    await checkIn(booking.appointment.id, 'terminal-race');
    const lifecycle = new AppointmentLifecycleService(pool);
    const results = await Promise.allSettled([
      lifecycle.command(scope, ids.session, booking.appointment.id, {
        command: 'no_show',
        reason: 'Verified absence',
        idempotencyKey: 'wu13-race-no-show',
        correlationId: 'wu13-race-no-show',
      }),
      lifecycle.command(scope, ids.session, booking.appointment.id, {
        command: 'cancel',
        reason: 'Concurrent cancellation',
        idempotencyKey: 'wu13-race-cancel',
        correlationId: 'wu13-race-cancel',
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const state = await pairedState(booking.appointment.id);
    expect([
      { appointment: 'no_show', entry: 'no_show' },
      { appointment: 'cancelled', entry: 'cancelled' },
    ]).toContainEqual({ appointment: state.appointment, entry: state.entry });
  });

  it('rejects stale terminal state and leaves no lifecycle side effects', async () => {
    const booking = await book('wu13-stale-book');
    await checkIn(booking.appointment.id, 'stale');
    await pool.query(
      `UPDATE queue_entries
          SET state='in_consultation', in_consultation_started_at=now()
        WHERE id=$1`,
      [booking.entry.id],
    );
    await pool.query(`UPDATE queue_entries SET state='completed' WHERE id=$1`, [
      booking.entry.id,
    ]);

    await expect(
      new AppointmentLifecycleService(pool).command(
        scope,
        ids.session,
        booking.appointment.id,
        {
          command: 'no_show',
          reason: 'Stale terminal attempt',
          idempotencyKey: 'wu13-stale-no-show',
          correlationId: 'wu13-stale-no-show',
        },
      ),
    ).rejects.toBeInstanceOf(AppointmentConflictError);
    expect(await pairedState(booking.appointment.id)).toMatchObject({
      appointment: 'completed',
      entry: 'completed',
    });
    const evidence = await pool.query<{ count: string }>(
      `SELECT count(*)::text count
         FROM appointment_lifecycle_receipts
        WHERE idempotency_key='wu13-stale-no-show'`,
    );
    expect(evidence.rows[0]!.count).toBe('0');
  });

  it('rejects an empty no-show reason before writing lifecycle state', async () => {
    const booking = await book('wu13-reason-book');
    await checkIn(booking.appointment.id, 'reason');

    await expect(
      new AppointmentLifecycleService(pool).command(
        scope,
        ids.session,
        booking.appointment.id,
        {
          command: 'no_show',
          reason: '   ',
          idempotencyKey: 'wu13-empty-reason',
          correlationId: 'wu13-empty-reason',
        },
      ),
    ).rejects.toThrow('No-show reason is required');
    expect(await pairedState(booking.appointment.id)).toMatchObject({
      appointment: 'checked_in',
      entry: 'checked_in',
    });
    const evidence = await pool.query<{ audits: string; receipts: string }>(
      `SELECT
        (SELECT count(*)::text FROM audit_events WHERE entity_id=$1 AND action='appointment.no_show') audits,
        (SELECT count(*)::text FROM appointment_lifecycle_receipts WHERE appointment_id=$1 AND command='no_show') receipts`,
      [booking.appointment.id],
    );
    expect(evidence.rows[0]).toEqual({ audits: '0', receipts: '0' });
  });

  it('rolls back tenant and queue-link mismatches without audit or receipts', async () => {
    const booking = await book('wu13-link-book');
    await checkIn(booking.appointment.id, 'link');
    const otherClinic = randomUUID();
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES($1,$2,'Other Clinic')`,
      [otherClinic, `wu13-other-${otherClinic}`],
    );
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role)
       VALUES($1,$2,'receptionist')`,
      [otherClinic, ids.receptionist],
    );
    await pool.query(`UPDATE queue_entries SET source='walk_in' WHERE id=$1`, [
      booking.entry.id,
    ]);
    const lifecycle = new AppointmentLifecycleService(pool);

    await expect(
      lifecycle.command(scope, ids.session, booking.appointment.id, {
        command: 'no_show',
        reason: 'Invalid link attempt',
        idempotencyKey: 'wu13-invalid-link',
        correlationId: 'wu13-invalid-link',
      }),
    ).rejects.toBeInstanceOf(AppointmentConflictError);
    await expect(
      lifecycle.command(
        { ...scope, clinicId: otherClinic },
        ids.session,
        booking.appointment.id,
        {
          command: 'no_show',
          reason: 'Wrong tenant attempt',
          idempotencyKey: 'wu13-wrong-tenant',
          correlationId: 'wu13-wrong-tenant',
        },
      ),
    ).rejects.toBeInstanceOf(AppointmentConflictError);

    expect(await pairedState(booking.appointment.id)).toMatchObject({
      appointment: 'checked_in',
      entry: 'checked_in',
    });
    const evidence = await pool.query<{ audits: string; receipts: string }>(
      `SELECT
        (SELECT count(*)::text FROM audit_events WHERE entity_id=$1 AND action='appointment.no_show') audits,
        (SELECT count(*)::text FROM appointment_lifecycle_receipts WHERE appointment_id=$1 AND command='no_show') receipts`,
      [booking.appointment.id],
    );
    expect(evidence.rows[0]).toEqual({ audits: '0', receipts: '0' });
  });
});
