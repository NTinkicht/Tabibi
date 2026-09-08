import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppointmentService, AppointmentConflictError } from '@/modules/appointment';
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
  return new AppointmentService(pool).bookForExistingPatient(scope, ids.session, {
    patientId: ids.patient,
    scheduledStartAt: new Date('2026-09-15T09:30:00Z'),
    scheduledEndAt: new Date('2026-09-15T09:45:00Z'),
    contactPreference: 'none',
    idempotencyKey: key,
    correlationId: key,
  });
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
    const first = await lifecycle.command(scope, ids.session, booking.appointment.id, input);
    const retry = await lifecycle.command(scope, ids.session, booking.appointment.id, input);

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
    expect(states.rows[0]).toEqual({ appointment: 'cancelled', entry: 'cancelled' });
    await expect(
      lifecycle.command(scope, ids.session, booking.appointment.id, {
        command: 'check_in',
        idempotencyKey: 'wu12-resurrect',
        correlationId: 'wu12-resurrect',
      }),
    ).rejects.toBeInstanceOf(AppointmentConflictError);
  });

  it('serializes simultaneous cancel/check-in into exactly one valid terminal-or-arrived outcome', async () => {
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
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const states = await pool.query<{ appointment: string; entry: string }>(
      `SELECT appointment.status::text appointment, entry.state::text entry
         FROM appointments appointment
         JOIN queue_entries entry ON entry.id=appointment.queue_entry_id
        WHERE appointment.id=$1`,
      [booking.appointment.id],
    );
    expect([
      { appointment: 'checked_in', entry: 'checked_in' },
      { appointment: 'cancelled', entry: 'cancelled' },
    ]).toContainEqual(states.rows[0]);
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
    const states = await pool.query<{ session: string; appointment: string; entry: string }>(
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
      expect(row).toMatchObject({ appointment: 'cancelled', entry: 'cancelled' });
    else
      expect(row).toMatchObject({ session: 'open', appointment: 'checked_in', entry: 'checked_in' });
  });
});
