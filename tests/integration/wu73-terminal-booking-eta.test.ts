import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import { PublicGuestBookingService } from '@/modules/public-guest-booking';
import { PublicGuestBookingCheckInService } from '@/modules/public-guest-booking-check-in';
import {
  PublicGuestLiveQueueStatusService,
} from '@/modules/public-guest-live-queue-status';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const selectionSecret = 'wu73-selection-secret-that-is-deliberately-long-enough';
const now = new Date('2099-05-01T00:00:00.000Z');

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE public_guest_booking_receipts, guest_credentials, guest_exchange_ids,
    audit_events, queue_reorder_receipts, queue_command_receipts, queue_registration_receipts,
    appointments, appointment_booking_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
});
afterAll(async () => pool.end());

type Booking = {
  clinicId: string;
  sessionId: string;
  appointmentId: string;
  bearer: string;
};

async function createCheckedInBooking(suffix: string): Promise<Booking> {
  const clinicId = randomUUID();
  const doctorId = randomUUID();
  const sessionId = randomUUID();
  const doctorUserId = randomUUID();
  const startsAt = '2099-05-15T08:00:00.000Z';
  const endsAt = '2099-05-15T09:00:00.000Z';
  const contactPhone = `+21355573${suffix.padStart(4, '0')}`;

  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES ($1,$2,'WU73 Doctor')`,
    [doctorUserId, `wu73-doctor-${doctorUserId}`],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name, status) VALUES ($1,$2,'WU73 Clinic','active')`,
    [clinicId, `wu73-clinic-${clinicId}`],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1,$2,'WU73 Doctor')`,
    [doctorId, doctorUserId],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1,$2)`,
    [clinicId, doctorId],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES ($1,$2,$3,'2099-05-15',$4,$5,'open')`,
    [sessionId, clinicId, doctorId, startsAt, endsAt],
  );

  const selections = new PublicAvailabilitySelectionService(
    pool,
    selectionSecret,
    () => now,
    60_000,
  );
  const selectionReference = await selections.issue({
    clinicId,
    doctorId,
    sessionId,
    startsAt,
    endsAt,
  });
  if (!selectionReference) throw new Error('selection reference not issued');

  const booked = await new PublicGuestBookingService(
    pool,
    selections,
    () => now,
  ).book({
    selectionReference,
    privateDisplayName: `WU73 Guest ${suffix}`,
    contactPhone,
    contactEmail: `wu73-${suffix}@example.com`,
    preferredLocale: 'fr',
    contactPreference: 'phone',
    idempotencyKey: `wu73-book-${suffix}`,
    correlationId: `wu73-book-correlation-${suffix}`,
  });

  const internal = await pool.query<{ id: string }>(
    `SELECT appointment.id
       FROM appointments appointment
       JOIN patient_operational_records patient ON patient.id=appointment.patient_id
      WHERE appointment.clinic_id=$1 AND appointment.session_id=$2 AND patient.contact_phone=$3`,
    [clinicId, sessionId, contactPhone],
  );
  const appointmentId = internal.rows[0]?.id;
  if (!appointmentId) throw new Error('booking internals not created');

  await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
    booked.guestBearer,
    `wu73-checkin-${suffix}`,
  );

  return { clinicId, sessionId, appointmentId, bearer: booked.guestBearer };
}

describe('WU73 terminal booking ETA suppression', () => {
  for (const [suffix, terminalState] of [
    ['7301', 'completed'],
    ['7302', 'cancelled'],
    ['7303', 'no_show'],
  ] as const) {
    it(`suppresses ETA for isolated ${terminalState} booking while queue remains checked_in`, async () => {
      const booking = await createCheckedInBooking(suffix);
      await pool.query(`UPDATE appointments SET status=$2 WHERE id=$1`, [
        booking.appointmentId,
        terminalState,
      ]);

      const service = new PublicGuestLiveQueueStatusService(pool, () => now);
      await expect(service.get(booking.bearer)).resolves.toEqual({
        bookingState: terminalState,
        queueState: 'checked_in',
        eta: null,
      });
    });
  }
});
