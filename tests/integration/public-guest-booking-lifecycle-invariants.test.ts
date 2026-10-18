import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
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

  // ARCHITECTURE.md TAB-FND-023: barrier-controlled runs start from the same
  // committed confirmed+waiting pair and force each operation to win. The
  // winner pauses after its operational mutation (holding the session and row
  // locks); the loser is released only once PostgreSQL reports it blocked on a
  // lock, so it must re-read the winner's committed pair.
  type Hook = (client: PoolClient) => Promise<void>;

  function barrier() {
    let reachedResolve!: () => void;
    let releaseResolve!: () => void;
    const reached = new Promise<void>((resolve) => (reachedResolve = resolve));
    const release = new Promise<void>((resolve) => (releaseResolve = resolve));
    const hook: Hook = async () => {
      reachedResolve();
      await release;
    };
    return { hook, reached, release: () => releaseResolve() };
  }

  async function waitForLockWaiters(count: number) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await pool.query<{ count: string }>(
        `SELECT count(*)::text count FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'`,
      );
      if (Number(waiting.rows[0]!.count) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('loser never blocked on the winner lock boundary');
  }

  async function forcedRace(winner: 'cancel' | 'check_in', suffix: string) {
    const booking = await createBooking(suffix);
    await openSession(booking);
    const before = await snapshot(booking);
    expect(before.pair).toMatchObject({
      appointment_status: 'confirmed',
      queue_state: 'waiting',
    });
    const gate = barrier();
    const cancel = new PublicGuestBookingCancellationService(
      pool,
      () => now,
      winner === 'cancel' ? gate.hook : undefined,
    );
    const checkIn = new PublicGuestBookingCheckInService(
      pool,
      () => now,
      winner === 'check_in' ? gate.hook : undefined,
    );
    const operationId = `op-${suffix}`;
    const runCancel = () =>
      settle(
        cancel.cancel(booking.bearer),
        PublicGuestBookingCancellationRejectedError,
      );
    const runCheckIn = () =>
      settle(
        checkIn.checkIn(booking.bearer, operationId),
        PublicGuestBookingCheckInRejectedError,
      );

    const winnerRun = winner === 'cancel' ? runCancel() : runCheckIn();
    await gate.reached;
    const loserRun = winner === 'cancel' ? runCheckIn() : runCancel();
    await waitForLockWaiters(1);
    gate.release();
    const [winnerOutcome, loserOutcome] = await Promise.all([
      winnerRun,
      loserRun,
    ]);
    return {
      booking,
      before,
      cancel,
      checkIn,
      operationId,
      winnerOutcome,
      loserOutcome,
    };
  }

  function expectNoMismatchedPair(pair: {
    appointment_status: string;
    queue_state: string;
  }) {
    expect([
      { appointment_status: 'checked_in', queue_state: 'checked_in' },
      { appointment_status: 'cancelled', queue_state: 'cancelled' },
    ]).toContainEqual({
      appointment_status: pair.appointment_status,
      queue_state: pair.queue_state,
    });
  }

  it('forces cancellation to win: check-in is rejected after re-reading the cancelled pair', async () => {
    const race = await forcedRace('cancel', '4001');
    expect(race.winnerOutcome).toBe('fulfilled');
    expect(race.loserOutcome).toBe('rejected');

    const after = await snapshot(race.booking);
    expectNoMismatchedPair(after.pair);
    expect(after.pair).toMatchObject({
      appointment_status: 'cancelled',
      queue_state: 'cancelled',
    });
    expect(Number(after.pair.queue_order_version)).toBe(
      Number(race.before.pair.queue_order_version) + 1,
    );
    expect(after.audits).toEqual([
      {
        action: 'public_guest_appointment_cancelled',
        metadata: {
          appointmentFrom: 'confirmed',
          appointmentTo: 'cancelled',
          queueFrom: 'waiting',
          queueTo: 'cancelled',
          authority: 'guest_capability',
        },
      },
    ]);
    expect(after.operations).toEqual([]);
    expect(after.queueEntryCount).toBe(1);
    expectPrivacySafe(race.booking, after.audits, race.operationId);

    // Exact retry of the winner is idempotent; the loser stays rejected.
    await expect(race.cancel.cancel(race.booking.bearer)).resolves.toEqual({
      status: 'cancelled',
    });
    await expect(
      race.checkIn.checkIn(race.booking.bearer, race.operationId),
    ).rejects.toBeInstanceOf(PublicGuestBookingCheckInRejectedError);
    expect(await snapshot(race.booking)).toEqual(after);
  });

  it('forces check-in to win: cancellation is rejected after re-reading the checked-in pair', async () => {
    const race = await forcedRace('check_in', '5001');
    expect(race.winnerOutcome).toBe('fulfilled');
    expect(race.loserOutcome).toBe('rejected');

    const after = await snapshot(race.booking);
    expectNoMismatchedPair(after.pair);
    expect(after.pair).toMatchObject({
      appointment_status: 'checked_in',
      queue_state: 'checked_in',
    });
    expect(Number(after.pair.queue_order_version)).toBe(
      Number(race.before.pair.queue_order_version) + 1,
    );
    expect(after.queueEntryCount).toBe(1);
    expect(after.operations).toEqual([race.operationId]);
    expect(after.audits).toEqual([CHECK_IN_AUDIT]);
    expectPrivacySafe(race.booking, after.audits, race.operationId);

    // Exact retry of the winning check-in is idempotent.
    await expect(
      race.checkIn.checkIn(race.booking.bearer, race.operationId),
    ).resolves.toEqual({ status: 'checked_in', reconciled: true });
    await expect(
      race.cancel.cancel(race.booking.bearer),
    ).rejects.toBeInstanceOf(PublicGuestBookingCancellationRejectedError);
    expect(await snapshot(race.booking)).toEqual(after);
  });
});
