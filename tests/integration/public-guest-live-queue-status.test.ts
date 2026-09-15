import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/public/bookings/live-queue-status/route';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import { PublicGuestBookingService } from '@/modules/public-guest-booking';
import { PublicGuestBookingCheckInService } from '@/modules/public-guest-booking-check-in';
import {
  PublicGuestLiveQueueStatusRejectedError,
  PublicGuestLiveQueueStatusService,
} from '@/modules/public-guest-live-queue-status';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const selectionSecret =
  'wu63-selection-secret-that-is-deliberately-long-enough';
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
  existing?: Booking,
): Promise<Booking> {
  const clinicId = existing?.clinicId ?? randomUUID();
  const doctorId = existing?.doctorId ?? randomUUID();
  const sessionId = existing?.sessionId ?? randomUUID();
  const startsAt = '2099-05-15T08:00:00.000Z';
  const endsAt = '2099-05-15T09:00:00.000Z';
  const privateDisplayName = `Private Guest ${suffix}`;
  const contactPhone = `+21355504${suffix.padStart(4, '0')}`;

  if (!existing) {
    const doctorUserId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1,$2,'Private Doctor')`,
      [doctorUserId, `wu63-doctor-${doctorUserId}`],
    );
    await pool.query(
      `INSERT INTO clinics (id, tenant_key, name, status) VALUES ($1,$2,'Private Clinic','active')`,
      [clinicId, `wu63-clinic-${clinicId}`],
    );
    await pool.query(
      `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1,$2,'Private Doctor')`,
      [doctorId, doctorUserId],
    );
    await pool.query(
      `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1,$2)`,
      [clinicId, doctorId],
    );
    await pool.query(
      `INSERT INTO consultation_sessions
      (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
      VALUES ($1,$2,$3,'2099-05-15',$4,$5,'planned')`,
      [sessionId, clinicId, doctorId, startsAt, endsAt],
    );
  }

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
    privateDisplayName,
    contactPhone,
    contactEmail: `${suffix}@example.com`,
    preferredLocale: 'fr',
    contactPreference: 'phone',
    idempotencyKey: `wu63-${suffix}`,
    correlationId: `wu63-correlation-${suffix}`,
  });
  const internal = await pool.query<{ id: string; queue_entry_id: string }>(
    `SELECT appointment.id, appointment.queue_entry_id
       FROM appointments appointment
       JOIN patient_operational_records patient ON patient.id=appointment.patient_id
      WHERE appointment.clinic_id=$1 AND appointment.session_id=$2 AND patient.contact_phone=$3`,
    [clinicId, sessionId, contactPhone],
  );
  const row = internal.rows[0];
  if (!row) throw new Error('booking internals not created');
  return {
    clinicId,
    doctorId,
    sessionId,
    queueEntryId: row.queue_entry_id,
    appointmentId: row.id,
    bearer: booked.guestBearer,
    privateDisplayName,
    contactPhone,
  };
}

async function openSession(booking: Booking) {
  await pool.query(
    `UPDATE consultation_sessions SET status='open' WHERE id=$1 AND clinic_id=$2`,
    [booking.sessionId, booking.clinicId],
  );
}

async function state(booking: Booking) {
  const result = await pool.query<{
    appointment_status: string;
    queue_state: string;
    queue_order_version: string;
  }>(
    `SELECT appointment.status::text appointment_status,
            entry.state::text queue_state,
            session.queue_order_version::text queue_order_version
       FROM appointments appointment
       JOIN queue_entries entry ON entry.id=appointment.queue_entry_id
       JOIN consultation_sessions session ON session.id=appointment.session_id
      WHERE appointment.id=$1`,
    [booking.appointmentId],
  );
  return result.rows[0];
}

async function auditCount(booking: Booking) {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text count FROM audit_events WHERE clinic_id=$1`,
    [booking.clinicId],
  );
  return Number(result.rows[0]!.count);
}

describe('WU63 public guest live queue status', () => {
  it("reads a valid capability's own durably bound booking and queue participation", async () => {
    const booking = await createBooking('1001');
    await openSession(booking);
    const service = new PublicGuestLiveQueueStatusService(pool, () => now);

    await expect(service.get(booking.bearer)).resolves.toEqual({
      bookingState: 'confirmed',
      queueState: 'waiting',
    });

    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu63-status-1001',
    );

    await expect(service.get(booking.bearer)).resolves.toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
    });
  });

  it('keeps a capability scoped to its own booking within the same session', async () => {
    const first = await createBooking('2101');
    const second = await createBooking('2102', first);
    await openSession(first);
    const service = new PublicGuestLiveQueueStatusService(pool, () => now);

    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      first.bearer,
      'wu63-status-2101',
    );

    await expect(service.get(first.bearer)).resolves.toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
    });
    await expect(service.get(second.bearer)).resolves.toEqual({
      bookingState: 'confirmed',
      queueState: 'waiting',
    });
  });

  it('rejects cross-clinic credential substitution at the database boundary', async () => {
    const source = await createBooking('2201');
    const target = await createBooking('2202');
    await openSession(source);
    await openSession(target);
    const service = new PublicGuestLiveQueueStatusService(pool, () => now);

    await expect(
      pool.query(
        `UPDATE guest_credentials
          SET clinic_id=$2, session_id=$3
        WHERE queue_entry_id=$1`,
        [source.queueEntryId, target.clinicId, target.sessionId],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    await expect(service.get(source.bearer)).resolves.toEqual({
      bookingState: 'confirmed',
      queueState: 'waiting',
    });
    await expect(service.get(target.bearer)).resolves.toEqual({
      bookingState: 'confirmed',
      queueState: 'waiting',
    });
  });

  it('rejects permitted queue-entry association drift instead of reading the reassigned queue state', async () => {
    const booking = await createBooking('2401');
    await openSession(booking);
    const driftPatientId = randomUUID();
    const driftQueueEntryId = randomUUID();
    await pool.query(
      `INSERT INTO patient_operational_records (id, clinic_id, private_display_name, contact_phone) VALUES ($1, $2, 'Drift Target', '0555004401')`,
      [driftPatientId, booking.clinicId],
    );
    await pool.query(
      `INSERT INTO queue_entries (id, clinic_id, session_id, patient_id, state, source, registration_order, eligibility_order, priority_order) SELECT $1, $2, $3, $4, 'waiting', 'walk_in', COALESCE(MAX(registration_order), 0) + 1, NULL, NULL FROM queue_entries WHERE clinic_id = $2 AND session_id = $3`,
      [driftQueueEntryId, booking.clinicId, booking.sessionId, driftPatientId],
    );
    await pool.query(
      `UPDATE guest_credentials SET queue_entry_id=$2 WHERE queue_entry_id=$1`,
      [booking.queueEntryId, driftQueueEntryId],
    );

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(booking.bearer)).rejects.toBeInstanceOf(
      PublicGuestLiveQueueStatusRejectedError,
    );
  });

  it('rejects immutable patient-association drift instead of reading the reassigned patient state', async () => {
    const booking = await createBooking('2301');
    await openSession(booking);
    const replacementPatientId = randomUUID();
    await pool.query(
      `INSERT INTO patient_operational_records (id, clinic_id, private_display_name, contact_phone) VALUES ($1, $2, 'Replacement Patient', '0555004301')`,
      [replacementPatientId, booking.clinicId],
    );
    await pool.query(`UPDATE appointments SET patient_id=$2 WHERE id=$1`, [
      booking.appointmentId,
      replacementPatientId,
    ]);
    await pool.query(`UPDATE queue_entries SET patient_id=$2 WHERE id=$1`, [
      booking.queueEntryId,
      replacementPatientId,
    ]);

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(booking.bearer)).rejects.toBeInstanceOf(
      PublicGuestLiveQueueStatusRejectedError,
    );
  });

  it('reads deterministic terminal booking and queue states', async () => {
    const service = new PublicGuestLiveQueueStatusService(pool, () => now);

    const cancelled = await createBooking('3101');
    await openSession(cancelled);
    await pool.query(`UPDATE appointments SET status='cancelled' WHERE id=$1`, [
      cancelled.appointmentId,
    ]);
    await pool.query(`UPDATE queue_entries SET state='cancelled' WHERE id=$1`, [
      cancelled.queueEntryId,
    ]);
    await expect(service.get(cancelled.bearer)).resolves.toEqual({
      bookingState: 'cancelled',
      queueState: 'cancelled',
    });
    await expect(service.get(cancelled.bearer)).resolves.toEqual({
      bookingState: 'cancelled',
      queueState: 'cancelled',
    });

    const noShow = await createBooking('3102');
    await openSession(noShow);
    await pool.query(`UPDATE appointments SET status='no_show' WHERE id=$1`, [
      noShow.appointmentId,
    ]);
    await pool.query(`UPDATE queue_entries SET state='no_show' WHERE id=$1`, [
      noShow.queueEntryId,
    ]);
    await expect(service.get(noShow.bearer)).resolves.toEqual({
      bookingState: 'no_show',
      queueState: 'no_show',
    });

    const completed = await createBooking('3103');
    await openSession(completed);
    await pool.query(`UPDATE appointments SET status='completed' WHERE id=$1`, [
      completed.appointmentId,
    ]);
    await pool.query(
      `UPDATE queue_entries SET state='in_consultation' WHERE id=$1`,
      [completed.queueEntryId],
    );
    await pool.query(`UPDATE queue_entries SET state='completed' WHERE id=$1`, [
      completed.queueEntryId,
    ]);
    await expect(service.get(completed.bearer)).resolves.toEqual({
      bookingState: 'completed',
      queueState: 'completed',
    });
  });

  it('fails closed for malformed, tampered, expired, and revoked credentials with the same generic rejection', async () => {
    const service = new PublicGuestLiveQueueStatusService(pool, () => now);

    await expect(service.get('not-a-bearer')).rejects.toBeInstanceOf(
      PublicGuestLiveQueueStatusRejectedError,
    );

    const tampered = await createBooking('4001');
    await openSession(tampered);
    const parts = tampered.bearer.split('.');
    await expect(
      service.get(`${parts[0]}.${parts[1]}.${'A'.repeat(43)}`),
    ).rejects.toBeInstanceOf(PublicGuestLiveQueueStatusRejectedError);

    const expired = await createBooking('4002');
    await openSession(expired);
    await pool.query(
      `UPDATE guest_credentials SET issued_at=$2, expires_at=$3 WHERE queue_entry_id=$1`,
      [
        expired.queueEntryId,
        new Date(now.getTime() - 2000),
        new Date(now.getTime() - 1000),
      ],
    );
    await expect(service.get(expired.bearer)).rejects.toBeInstanceOf(
      PublicGuestLiveQueueStatusRejectedError,
    );

    const revoked = await createBooking('4003');
    await openSession(revoked);
    await pool.query(
      `UPDATE guest_credentials SET revoked_at=$2 WHERE queue_entry_id=$1`,
      [revoked.queueEntryId, now],
    );
    await expect(service.get(revoked.bearer)).rejects.toBeInstanceOf(
      PublicGuestLiveQueueStatusRejectedError,
    );
  });

  it('creates no mutation, version change, or audit event across repeated and concurrent polling', async () => {
    const booking = await createBooking('5001');
    await openSession(booking);
    const service = new PublicGuestLiveQueueStatusService(pool, () => now);

    const before = await state(booking);
    const auditsBefore = await auditCount(booking);

    await expect(
      Promise.all([
        service.get(booking.bearer),
        service.get(booking.bearer),
        service.get(booking.bearer),
      ]),
    ).resolves.toEqual([
      { bookingState: 'confirmed', queueState: 'waiting' },
      { bookingState: 'confirmed', queueState: 'waiting' },
      { bookingState: 'confirmed', queueState: 'waiting' },
    ]);
    await service.get(booking.bearer);
    await service.get(booking.bearer);

    expect(await state(booking)).toEqual(before);
    expect(await auditCount(booking)).toBe(auditsBefore);
  });

  it('keeps the public route bearer-only and serialization allow-listed', async () => {
    const booking = await createBooking('6001');
    await openSession(booking);
    const response = await GET(
      new Request('http://localhost/api/public/bookings/live-queue-status', {
        headers: { authorization: `Bearer ${booking.bearer}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ bookingState: 'confirmed', queueState: 'waiting' });
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      booking.bearer,
      booking.privateDisplayName,
      booking.contactPhone,
      booking.clinicId,
      booking.doctorId,
      booking.sessionId,
      booking.queueEntryId,
      booking.appointmentId,
    ])
      expect(serialized).not.toContain(forbidden);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('rejects a request with no bearer at the route level', async () => {
    const response = await GET(
      new Request('http://localhost/api/public/bookings/live-queue-status'),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.status).toBe('rejected');
  });
});
