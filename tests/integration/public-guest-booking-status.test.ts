import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import { PublicGuestBookingService } from '@/modules/public-guest-booking';
import {
  PublicGuestBookingStatusRejectedError,
  PublicGuestBookingStatusService,
} from '@/modules/public-guest-booking-status';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const selectionSecret =
  'wu60-selection-secret-that-is-deliberately-long-enough';
const now = new Date('2099-02-01T00:00:00.000Z');

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE public_guest_booking_receipts, guest_credentials, guest_exchange_ids,
    audit_events, queue_reorder_receipts, queue_command_receipts, queue_registration_receipts,
    appointments, appointment_booking_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
});
afterAll(async () => pool.end());

type SeededBooking = {
  clinicId: string;
  doctorId: string;
  sessionId: string;
  queueEntryId: string;
  appointmentId: string;
  bearer: string;
  privateDisplayName: string;
  contactPhone: string;
};

async function createBooking(
  suffix: string,
  preferredLocale: 'ar' | 'fr' = 'fr',
): Promise<SeededBooking> {
  const clinicId = randomUUID();
  const doctorId = randomUUID();
  const doctorUserId = randomUUID();
  const sessionId = randomUUID();
  const startsAt = '2099-03-01T08:00:00.000Z';
  const endsAt = '2099-03-01T09:00:00.000Z';
  const privateDisplayName = `Private Guest ${suffix}`;
  const contactPhone = `+21355501${suffix.padStart(4, '0')}`;

  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, 'Private Doctor')`,
    [doctorUserId, `wu60-doctor-${doctorUserId}`],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name, status) VALUES ($1, $2, 'Private Clinic', 'active')`,
    [clinicId, `wu60-clinic-${clinicId}`],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Private Doctor')`,
    [doctorId, doctorUserId],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
    [clinicId, doctorId],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES ($1, $2, $3, '2099-03-01', $4, $5, 'planned')`,
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

  const booking = await new PublicGuestBookingService(
    pool,
    selections,
    () => now,
  ).book({
    selectionReference,
    privateDisplayName,
    contactPhone,
    contactEmail: `${suffix}@example.com`,
    preferredLocale,
    contactPreference: 'phone',
    idempotencyKey: `wu60-${suffix}`,
    correlationId: `wu60-correlation-${suffix}`,
  });

  const internal = await pool.query<{
    id: string;
    queue_entry_id: string;
  }>(
    `SELECT id, queue_entry_id
       FROM appointments
      WHERE clinic_id=$1 AND session_id=$2`,
    [clinicId, sessionId],
  );
  const row = internal.rows[0];
  if (!row) throw new Error('booking internals not created');

  return {
    clinicId,
    doctorId,
    sessionId,
    queueEntryId: row.queue_entry_id,
    appointmentId: row.id,
    bearer: booking.guestBearer,
    privateDisplayName,
    contactPhone,
  };
}

async function mutationCounts() {
  const result = await pool.query<Record<string, string>>(`SELECT
    (SELECT count(*)::text FROM appointments) appointments,
    (SELECT count(*)::text FROM queue_entries) entries,
    (SELECT count(*)::text FROM consultation_sessions) sessions,
    (SELECT count(*)::text FROM guest_credentials) credentials,
    (SELECT count(*)::text FROM audit_events) audits`);
  return result.rows[0];
}

describe('WU60 public guest booking status', () => {
  it('returns an allow-listed localized projection and repeated reads are mutation-free', async () => {
    const booking = await createBooking('1001', 'ar');
    const service = new PublicGuestBookingStatusService(
      pool,
      undefined,
      () => now,
    );
    const before = await mutationCounts();

    const first = await service.get(booking.bearer);
    const second = await service.get(booking.bearer);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      bookingState: 'confirmed',
      serviceDate: '2099-03-01',
      queueState: 'waiting',
      called: false,
      preferredLocale: 'ar',
    });
    expect(first.queueLabel).toMatch(/^W-[A-F0-9]{10}$/);
    expect(first.startsAt).toBe('2099-03-01T08:00:00.000Z');
    expect(first.endsAt).toBe('2099-03-01T09:00:00.000Z');

    const serialized = JSON.stringify(first);
    for (const forbidden of [
      booking.clinicId,
      booking.doctorId,
      booking.sessionId,
      booking.queueEntryId,
      booking.appointmentId,
      booking.privateDisplayName,
      booking.contactPhone,
      'patient',
      'audit',
      'credential',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(await mutationCounts()).toEqual(before);
  });

  it.each([
    ['cancelled', 'cancelled'],
    ['no_show', 'no_show'],
    ['completed', 'completed'],
  ] as const)(
    'projects terminal appointment/queue state %s without weakening active-only authorization elsewhere',
    async (appointmentState, queueState) => {
      const booking = await createBooking(`2-${appointmentState}`, 'fr');
      await pool.query('UPDATE appointments SET status=$2 WHERE id=$1', [
        booking.appointmentId,
        appointmentState,
      ]);
      if (queueState === 'completed') {
        await pool.query(
          `UPDATE queue_entries SET state='in_consultation' WHERE id=$1`,
          [booking.queueEntryId],
        );
      }
      await pool.query('UPDATE queue_entries SET state=$2 WHERE id=$1', [
        booking.queueEntryId,
        queueState,
      ]);

      const status = await new PublicGuestBookingStatusService(
        pool,
        undefined,
        () => now,
      ).get(booking.bearer);

      expect(status).toMatchObject({
        bookingState: appointmentState,
        queueState,
        preferredLocale: 'fr',
      });
    },
  );

  it('fails closed for tampered, expired, and revoked capabilities with one external error type', async () => {
    const booking = await createBooking('3001');
    const service = new PublicGuestBookingStatusService(
      pool,
      undefined,
      () => now,
    );
    const parts = booking.bearer.split('.');
    expect(parts).toHaveLength(3);
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(43)}`;

    await expect(service.get(tampered)).rejects.toBeInstanceOf(
      PublicGuestBookingStatusRejectedError,
    );

    await pool.query(
      'UPDATE guest_credentials SET issued_at=$1, expires_at=$2',
      [new Date(now.getTime() - 120_000), new Date(now.getTime() - 1)],
    );
    await expect(service.get(booking.bearer)).rejects.toBeInstanceOf(
      PublicGuestBookingStatusRejectedError,
    );

    await pool.query(
      'UPDATE guest_credentials SET issued_at=$1, expires_at=$2, revoked_at=$3',
      [now, new Date(now.getTime() + 60_000), new Date(now.getTime() + 1)],
    );
    await expect(service.get(booking.bearer)).rejects.toBeInstanceOf(
      PublicGuestBookingStatusRejectedError,
    );
  });

  it('keeps two similarly shaped bookings isolated by capability scope', async () => {
    const first = await createBooking('4001', 'fr');
    const second = await createBooking('4002', 'ar');
    await pool.query(
      `UPDATE appointments SET status='checked_in' WHERE id=$1`,
      [second.appointmentId],
    );
    await pool.query(
      `UPDATE queue_entries SET state='checked_in' WHERE id=$1`,
      [second.queueEntryId],
    );

    const service = new PublicGuestBookingStatusService(
      pool,
      undefined,
      () => now,
    );
    const firstStatus = await service.get(first.bearer);
    const secondStatus = await service.get(second.bearer);

    expect(firstStatus).toMatchObject({
      bookingState: 'confirmed',
      queueState: 'waiting',
      preferredLocale: 'fr',
    });
    expect(secondStatus).toMatchObject({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      preferredLocale: 'ar',
    });
    expect(JSON.stringify(firstStatus)).not.toContain(second.queueEntryId);
    expect(JSON.stringify(secondStatus)).not.toContain(first.queueEntryId);
  });
});
