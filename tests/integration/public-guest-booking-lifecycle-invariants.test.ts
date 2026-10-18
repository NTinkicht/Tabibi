import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import { PublicGuestBookingService } from '@/modules/public-guest-booking';
import {
  PublicGuestBookingCancellationRejectedError,
  PublicGuestBookingCancellationService,
} from '@/modules/public-guest-booking-cancellation';
import {
  PublicGuestBookingCheckInRejectedError,
  PublicGuestBookingCheckInService,
} from '@/modules/public-guest-booking-check-in';
import { migrate } from '../../scripts/db/lib';

// Issue #623: appointment-to-queue lifecycle invariant matrix for the
// guest-capability paths. Cancellation and check-in are separate services
// with separate per-credential advisory locks, so their mutual ordering is
// enforced only by the session/appointment/queue row locks. These tests
// race the two commands against each other and assert that every
// committed outcome is a consistent appointment/queue pair whose durable
// effects (audits, operation records, session version) match exactly the
// commands that reported success.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const selectionSecret =
  'inv623-selection-secret-that-is-deliberately-long-enough';
const now = new Date('2099-05-01T00:00:00.000Z');

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE public_guest_check_in_operations, public_guest_booking_receipts,
    guest_credentials, guest_exchange_ids,
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
  credentialId: string;
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
  const contactPhone = `+21355503${suffix.padStart(4, '0')}`;

  if (!existing) {
    const doctorUserId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1,$2,'Private Doctor')`,
      [doctorUserId, `inv623-doctor-${doctorUserId}`],
    );
    await pool.query(
      `INSERT INTO clinics (id, tenant_key, name, status) VALUES ($1,$2,'Private Clinic','active')`,
      [clinicId, `inv623-clinic-${clinicId}`],
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
    idempotencyKey: `inv623-${suffix}`,
    correlationId: `inv623-correlation-${suffix}`,
  });
  const internal = await pool.query<{
    id: string;
    queue_entry_id: string;
    credential_id: string;
  }>(
    `SELECT appointment.id, appointment.queue_entry_id, credential.id AS credential_id
       FROM appointments appointment
       JOIN patient_operational_records patient ON patient.id=appointment.patient_id
       JOIN guest_credentials credential ON credential.queue_entry_id=appointment.queue_entry_id
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
    credentialId: row.credential_id,
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

async function snapshot(booking: Booking) {
  const pair = await pool.query<{
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
  const audits = await pool.query<{
    action: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT action, metadata FROM audit_events
      WHERE clinic_id=$1 AND entity_id=$2
        AND action IN ('public_guest_appointment_checked_in',
                       'public_guest_appointment_cancelled')
      ORDER BY occurred_at, action`,
    [booking.clinicId, booking.appointmentId],
  );
  const operations = await pool.query<{ operation_id: string }>(
    `SELECT operation_id FROM public_guest_check_in_operations
      WHERE credential_id=$1`,
    [booking.credentialId],
  );
  const entries = await pool.query<{ count: string }>(
    `SELECT count(*)::text count FROM queue_entries entry
       JOIN patient_operational_records patient ON patient.id=entry.patient_id
      WHERE entry.clinic_id=$1 AND entry.session_id=$2
        AND patient.contact_phone=$3`,
    [booking.clinicId, booking.sessionId, booking.contactPhone],
  );
  return {
    pair: pair.rows[0]!,
    audits: audits.rows,
    operations: operations.rows.map((row) => row.operation_id),
    queueEntryCount: Number(entries.rows[0]!.count),
  };
}

function expectPrivacySafe(
  booking: Booking,
  audits: { metadata: Record<string, unknown> }[],
  operationId: string,
) {
  const serialized = JSON.stringify(audits);
  for (const forbidden of [
    booking.bearer,
    booking.privateDisplayName,
    booking.contactPhone,
    booking.doctorId,
    booking.sessionId,
    booking.queueEntryId,
    operationId,
  ])
    expect(serialized).not.toContain(forbidden);
}

type Outcome = 'fulfilled' | 'rejected';

async function settle<T>(
  promise: Promise<T>,
  rejection: new () => Error,
): Promise<Outcome> {
  try {
    await promise;
    return 'fulfilled';
  } catch (error) {
    // Only the service's generic rejection is an acceptable loser outcome;
    // deadlocks, serialization or constraint errors must fail the test.
    expect(error).toBeInstanceOf(rejection);
    return 'rejected';
  }
}

const CHECK_IN_AUDIT = {
  action: 'public_guest_appointment_checked_in',
  metadata: {
    appointmentFrom: 'confirmed',
    appointmentTo: 'checked_in',
    queueFrom: 'waiting',
    queueTo: 'checked_in',
    authority: 'guest_capability',
  },
};

describe('#623 public guest appointment-to-queue lifecycle invariants', () => {
  it('books exactly one waiting queue entry per confirmed appointment', async () => {
    const first = await createBooking('1001');
    const second = await createBooking('1002', first);
    for (const booking of [first, second]) {
      const view = await snapshot(booking);
      expect(view.pair).toMatchObject({
        appointment_status: 'confirmed',
        queue_state: 'waiting',
      });
      expect(view.queueEntryCount).toBe(1);
      expect(view.audits).toEqual([]);
      expect(view.operations).toEqual([]);
    }
    expect(first.queueEntryId).not.toBe(second.queueEntryId);
  });

  it('rejects check-in after a committed cancellation and leaves no check-in effects', async () => {
    const booking = await createBooking('2001');
    await openSession(booking);
    const cancel = new PublicGuestBookingCancellationService(pool, () => now);
    const checkIn = new PublicGuestBookingCheckInService(pool, () => now);

    await cancel.cancel(booking.bearer);
    const cancelled = await snapshot(booking);
    await expect(
      checkIn.checkIn(booking.bearer, 'op-2001-a'),
    ).rejects.toBeInstanceOf(PublicGuestBookingCheckInRejectedError);
    // The rejected operationId is not durably recorded, so a retry is also
    // rejected rather than reconciled into a fictitious check-in.
    await expect(
      checkIn.checkIn(booking.bearer, 'op-2001-a'),
    ).rejects.toBeInstanceOf(PublicGuestBookingCheckInRejectedError);
    expect(await snapshot(booking)).toEqual(cancelled);
    expect(cancelled.pair).toMatchObject({
      appointment_status: 'cancelled',
      queue_state: 'cancelled',
    });
    expect(cancelled.operations).toEqual([]);
  });

  it('cancels a checked-in booking as a synchronized pair with one audit per command', async () => {
    const booking = await createBooking('3001');
    await openSession(booking);
    const cancel = new PublicGuestBookingCancellationService(pool, () => now);
    const checkIn = new PublicGuestBookingCheckInService(pool, () => now);
    const before = await snapshot(booking);

    await checkIn.checkIn(booking.bearer, 'op-3001-a');
    await cancel.cancel(booking.bearer);
    await expect(cancel.cancel(booking.bearer)).resolves.toEqual({
      status: 'cancelled',
    });

    const after = await snapshot(booking);
    expect(after.pair).toMatchObject({
      appointment_status: 'cancelled',
      queue_state: 'cancelled',
    });
    expect(Number(after.pair.queue_order_version)).toBe(
      Number(before.pair.queue_order_version) + 2,
    );
    expect(after.audits.map((row) => row.action).sort()).toEqual([
      'public_guest_appointment_cancelled',
      'public_guest_appointment_checked_in',
    ]);
    expect(after.audits).toContainEqual({
      action: 'public_guest_appointment_cancelled',
      metadata: {
        appointmentFrom: 'checked_in',
        appointmentTo: 'cancelled',
        queueFrom: 'checked_in',
        queueTo: 'cancelled',
        authority: 'guest_capability',
      },
    });
    expect(after.queueEntryCount).toBe(1);
    expectPrivacySafe(booking, after.audits, 'op-3001-a');
  });

  it('races cancellation against check-in without split state, deadlock, or unmatched effects', async () => {
    const seed = await createBooking('4000');
    await openSession(seed);
    const bookings = [seed];
    for (let index = 1; index < 8; index += 1)
      bookings.push(await createBooking(String(4000 + index), seed));

    const cancel = new PublicGuestBookingCancellationService(pool, () => now);
    const checkIn = new PublicGuestBookingCheckInService(pool, () => now);
    const versionBefore = Number(
      (await snapshot(seed)).pair.queue_order_version,
    );

    // Alternate submission order so both interleavings are exercised.
    const races = bookings.map((booking, index) => {
      const operationId = `op-race-${index}`;
      const cancelRun = () =>
        settle(
          cancel.cancel(booking.bearer),
          PublicGuestBookingCancellationRejectedError,
        );
      const checkInRun = () =>
        settle(
          checkIn.checkIn(booking.bearer, operationId),
          PublicGuestBookingCheckInRejectedError,
        );
      return index % 2 === 0
        ? Promise.all([cancelRun(), checkInRun()])
        : Promise.all([checkInRun(), cancelRun()]).then(
            ([checkedIn, cancelled]) => [cancelled, checkedIn] as const,
          );
    });
    const outcomes = await Promise.all(races);

    let committedCommands = 0;
    for (const [index, booking] of bookings.entries()) {
      const [cancelOutcome, checkInOutcome] = outcomes[index]!;
      const operationId = `op-race-${index}`;
      // Cancellation is eligible from both waiting and checked_in, so it
      // always commits; check-in commits only if it wins the row lock.
      expect(cancelOutcome).toBe('fulfilled');
      const view = await snapshot(booking);
      expect(view.pair).toMatchObject({
        appointment_status: 'cancelled',
        queue_state: 'cancelled',
      });
      expect(view.queueEntryCount).toBe(1);

      const cancelAudits = view.audits.filter(
        (row) => row.action === 'public_guest_appointment_cancelled',
      );
      const checkInAudits = view.audits.filter(
        (row) => row.action === 'public_guest_appointment_checked_in',
      );
      expect(cancelAudits).toHaveLength(1);
      if (checkInOutcome === 'fulfilled') {
        expect(checkInAudits).toEqual([CHECK_IN_AUDIT]);
        expect(view.operations).toEqual([operationId]);
        expect(cancelAudits[0]!.metadata).toMatchObject({
          appointmentFrom: 'checked_in',
          queueFrom: 'checked_in',
        });
        committedCommands += 2;
      } else {
        expect(checkInAudits).toEqual([]);
        expect(view.operations).toEqual([]);
        expect(cancelAudits[0]!.metadata).toMatchObject({
          appointmentFrom: 'confirmed',
          queueFrom: 'waiting',
        });
        committedCommands += 1;
      }
      expectPrivacySafe(booking, view.audits, operationId);

      // Retries after the race are side-effect free.
      const settled = await snapshot(booking);
      await expect(cancel.cancel(booking.bearer)).resolves.toEqual({
        status: 'cancelled',
      });
      if (checkInOutcome === 'fulfilled') {
        await expect(
          checkIn.checkIn(booking.bearer, operationId),
        ).resolves.toEqual({ status: 'checked_in', reconciled: true });
      } else {
        await expect(
          checkIn.checkIn(booking.bearer, operationId),
        ).rejects.toBeInstanceOf(PublicGuestBookingCheckInRejectedError);
      }
      expect(await snapshot(booking)).toEqual(settled);
    }

    // The shared session version advances exactly once per committed command.
    expect(Number((await snapshot(seed)).pair.queue_order_version)).toBe(
      versionBefore + committedCommands,
    );
  });
});
