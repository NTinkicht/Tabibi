import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/public/bookings/cancel/route';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import { PublicGuestBookingService } from '@/modules/public-guest-booking';
import {
  PublicGuestBookingCancellationRejectedError,
  PublicGuestBookingCancellationService,
} from '@/modules/public-guest-booking-cancellation';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const selectionSecret =
  'wu61-selection-secret-that-is-deliberately-long-enough';
const now = new Date('2099-04-01T00:00:00.000Z');

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
  patientId: string;
  bearer: string;
  privateDisplayName: string;
  contactPhone: string;
};

async function createBooking(suffix: string): Promise<SeededBooking> {
  const clinicId = randomUUID();
  const doctorId = randomUUID();
  const doctorUserId = randomUUID();
  const sessionId = randomUUID();
  const startsAt = '2099-04-15T08:00:00.000Z';
  const endsAt = '2099-04-15T09:00:00.000Z';
  const privateDisplayName = `Private Guest ${suffix}`;
  const contactPhone = `+21355502${suffix.padStart(4, '0')}`;

  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, 'Private Doctor')`,
    [doctorUserId, `wu61-doctor-${doctorUserId}`],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name, status) VALUES ($1, $2, 'Private Clinic', 'active')`,
    [clinicId, `wu61-clinic-${clinicId}`],
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
     VALUES ($1, $2, $3, '2099-04-15', $4, $5, 'planned')`,
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
    preferredLocale: 'fr',
    contactPreference: 'phone',
    idempotencyKey: `wu61-${suffix}`,
    correlationId: `wu61-correlation-${suffix}`,
  });

  const internal = await pool.query<{
    id: string;
    queue_entry_id: string;
    patient_id: string;
  }>(
    `SELECT id, queue_entry_id, patient_id
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
    patientId: row.patient_id,
    bearer: booking.guestBearer,
    privateDisplayName,
    contactPhone,
  };
}

async function state(booking: SeededBooking) {
  const result = await pool.query<{
    appointment_status: string;
    queue_state: string;
    priority_order: string | null;
    queue_order_version: string;
  }>(
    `SELECT appointment.status::text appointment_status,
            entry.state::text queue_state,
            entry.priority_order::text priority_order,
            session.queue_order_version::text queue_order_version
       FROM appointments appointment
       JOIN queue_entries entry ON entry.id=appointment.queue_entry_id
       JOIN consultation_sessions session ON session.id=appointment.session_id
      WHERE appointment.id=$1`,
    [booking.appointmentId],
  );
  return result.rows[0];
}

async function cancellationAudits(booking: SeededBooking) {
  return pool.query<{ action: string; metadata: Record<string, unknown> }>(
    `SELECT action, metadata
       FROM audit_events
      WHERE clinic_id=$1 AND entity_id=$2
        AND action='public_guest_appointment_cancelled'
      ORDER BY created_at`,
    [booking.clinicId, booking.appointmentId],
  );
}

describe('WU61 public guest booking cancellation', () => {
  it('atomically cancels appointment and queue once and emits one privacy-safe audit', async () => {
    const booking = await createBooking('1001');
    const service = new PublicGuestBookingCancellationService(
      pool,
      () => now,
    );
    const before = await state(booking);

    await expect(service.cancel(booking.bearer)).resolves.toEqual({
      status: 'cancelled',
    });
    const after = await state(booking);
    expect(after).toMatchObject({
      appointment_status: 'cancelled',
      queue_state: 'cancelled',
      priority_order: null,
    });
    expect(Number(after?.queue_order_version)).toBe(
      Number(before?.queue_order_version) + 1,
    );

    const firstAudits = await cancellationAudits(booking);
    expect(firstAudits.rows).toHaveLength(1);
    expect(firstAudits.rows[0]?.metadata).toEqual({
      appointmentFrom: 'confirmed',
      appointmentTo: 'cancelled',
      queueFrom: 'waiting',
      queueTo: 'cancelled',
      authority: 'guest_capability',
    });
    const serializedAudit = JSON.stringify(firstAudits.rows[0]);
    for (const forbidden of [
      booking.bearer,
      booking.privateDisplayName,
      booking.contactPhone,
      booking.doctorId,
      booking.sessionId,
      booking.queueEntryId,
    ]) {
      expect(serializedAudit).not.toContain(forbidden);
    }

    await expect(service.cancel(booking.bearer)).resolves.toEqual({
      status: 'cancelled',
    });
    expect(await state(booking)).toEqual(after);
    expect((await cancellationAudits(booking)).rows).toHaveLength(1);
  });

  it('converges concurrent equivalent cancellations to one committed mutation and audit', async () => {
    const booking = await createBooking('2001');
    const service = new PublicGuestBookingCancellationService(
      pool,
      () => now,
    );
    const before = await state(booking);

    const results = await Promise.all([
      service.cancel(booking.bearer),
      service.cancel(booking.bearer),
      service.cancel(booking.bearer),
    ]);
    expect(results).toEqual([
      { status: 'cancelled' },
      { status: 'cancelled' },
      { status: 'cancelled' },
    ]);

    const after = await state(booking);
    expect(after).toMatchObject({
      appointment_status: 'cancelled',
      queue_state: 'cancelled',
    });
    expect(Number(after?.queue_order_version)).toBe(
      Number(before?.queue_order_version) + 1,
    );
    expect((await cancellationAudits(booking)).rows).toHaveLength(1);
  });

  it('keeps another booking isolated from a valid cancellation', async () => {
    const first = await createBooking('3001');
    const second = await createBooking('3002');
    const secondBefore = await state(second);

    await new PublicGuestBookingCancellationService(pool, () => now).cancel(
      first.bearer,
    );

    expect(await state(first)).toMatchObject({
      appointment_status: 'cancelled',
      queue_state: 'cancelled',
    });
    expect(await state(second)).toEqual(secondBefore);
    expect((await cancellationAudits(second)).rows).toHaveLength(0);
  });

  it('fails closed on durable association drift with zero cancellation writes', async () => {
    const booking = await createBooking('4001');
    const replacementPatientId = randomUUID();
    await pool.query(
      `INSERT INTO patient_operational_records
         (id, clinic_id, private_display_name, contact_phone)
       VALUES($1,$2,'Drift Patient','+213555029999')`,
      [replacementPatientId, booking.clinicId],
    );
    await pool.query('UPDATE appointments SET patient_id=$2 WHERE id=$1', [
      booking.appointmentId,
      replacementPatientId,
    ]);
    const before = await state(booking);

    await expect(
      new PublicGuestBookingCancellationService(pool, () => now).cancel(
        booking.bearer,
      ),
    ).rejects.toBeInstanceOf(PublicGuestBookingCancellationRejectedError);

    expect(await state(booking)).toEqual(before);
    expect((await cancellationAudits(booking)).rows).toHaveLength(0);
  });

  it('rejects tampered, expired, and revoked capabilities equivalently without cancellation mutation', async () => {
    const tamperedBooking = await createBooking('5001');
    const parts = tamperedBooking.bearer.split('.');
    expect(parts).toHaveLength(3);
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(43)}`;
    const service = new PublicGuestBookingCancellationService(
      pool,
      () => now,
    );

    await expect(service.cancel(tampered)).rejects.toBeInstanceOf(
      PublicGuestBookingCancellationRejectedError,
    );
    expect(await state(tamperedBooking)).toMatchObject({
      appointment_status: 'confirmed',
      queue_state: 'waiting',
    });

    const expiredBooking = await createBooking('5002');
    await pool.query(
      'UPDATE guest_credentials SET expires_at=$2 WHERE queue_entry_id=$1',
      [expiredBooking.queueEntryId, new Date(now.getTime() - 1)],
    );
    await expect(service.cancel(expiredBooking.bearer)).rejects.toBeInstanceOf(
      PublicGuestBookingCancellationRejectedError,
    );
    expect(await state(expiredBooking)).toMatchObject({
      appointment_status: 'confirmed',
      queue_state: 'waiting',
    });

    const revokedBooking = await createBooking('5003');
    await pool.query(
      'UPDATE guest_credentials SET revoked_at=$2 WHERE queue_entry_id=$1',
      [revokedBooking.queueEntryId, now],
    );
    await expect(service.cancel(revokedBooking.bearer)).rejects.toBeInstanceOf(
      PublicGuestBookingCancellationRejectedError,
    );
    expect(await state(revokedBooking)).toMatchObject({
      appointment_status: 'confirmed',
      queue_state: 'waiting',
    });

    expect((await cancellationAudits(tamperedBooking)).rows).toHaveLength(0);
    expect((await cancellationAudits(expiredBooking)).rows).toHaveLength(0);
    expect((await cancellationAudits(revokedBooking)).rows).toHaveLength(0);
  });

  it.each([
    ['completed', 'completed'],
    ['no_show', 'no_show'],
  ] as const)(
    'rejects non-cancellable terminal state %s without mutation',
    async (appointmentState, queueState) => {
      const booking = await createBooking(`600-${appointmentState}`);
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
      const before = await state(booking);

      await expect(
        new PublicGuestBookingCancellationService(pool, () => now).cancel(
          booking.bearer,
        ),
      ).rejects.toBeInstanceOf(PublicGuestBookingCancellationRejectedError);

      expect(await state(booking)).toEqual(before);
      expect((await cancellationAudits(booking)).rows).toHaveLength(0);
    },
  );

  it('rolls back appointment, queue, session version and audit on an injected late failure', async () => {
    const booking = await createBooking('7001');
    const before = await state(booking);
    const service = new PublicGuestBookingCancellationService(
      pool,
      () => now,
      async () => {
        throw new Error('injected-late-failure');
      },
    );

    await expect(service.cancel(booking.bearer)).rejects.toThrow(
      'injected-late-failure',
    );
    expect(await state(booking)).toEqual(before);
    expect((await cancellationAudits(booking)).rows).toHaveLength(0);
  });

  it('serves bearer-only public cancellation with an allow-listed privacy-safe response', async () => {
    const booking = await createBooking('8001');
    const response = await POST(
      new Request('http://localhost/api/public/bookings/cancel', {
        method: 'POST',
        headers: { authorization: `Bearer ${booking.bearer}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    await expect(response.json()).resolves.toEqual({ status: 'cancelled' });

    const missing = await POST(
      new Request('http://localhost/api/public/bookings/cancel', {
        method: 'POST',
      }),
    );
    expect(missing.status).toBe(400);
    const missingBody = (await missing.json()) as Record<string, unknown>;
    expect(missingBody.status).toBe('rejected');
    expect(typeof missingBody.requestId).toBe('string');
    const serialized = JSON.stringify(missingBody);
    for (const forbidden of [
      booking.clinicId,
      booking.doctorId,
      booking.sessionId,
      booking.queueEntryId,
      booking.appointmentId,
      booking.patientId,
      booking.privateDisplayName,
      booking.contactPhone,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
