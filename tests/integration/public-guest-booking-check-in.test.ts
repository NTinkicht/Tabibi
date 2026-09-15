import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/public/bookings/check-in/route';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import { PublicGuestBookingService } from '@/modules/public-guest-booking';
import {
  PublicGuestBookingCheckInRejectedError,
  PublicGuestBookingCheckInService,
  PublicGuestBookingCheckInValidationError,
} from '@/modules/public-guest-booking-check-in';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const selectionSecret =
  'wu62-selection-secret-that-is-deliberately-long-enough';
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
      [doctorUserId, `wu62-doctor-${doctorUserId}`],
    );
    await pool.query(
      `INSERT INTO clinics (id, tenant_key, name, status) VALUES ($1,$2,'Private Clinic','active')`,
      [clinicId, `wu62-clinic-${clinicId}`],
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
    idempotencyKey: `wu62-${suffix}`,
    correlationId: `wu62-correlation-${suffix}`,
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

async function state(booking: Booking) {
  const result = await pool.query<{
    appointment_status: string;
    queue_state: string;
    eligibility_order: string | null;
    queue_order_version: string;
  }>(
    `SELECT appointment.status::text appointment_status,
            entry.state::text queue_state,
            entry.eligibility_order::text eligibility_order,
            session.queue_order_version::text queue_order_version
       FROM appointments appointment
       JOIN queue_entries entry ON entry.id=appointment.queue_entry_id
       JOIN consultation_sessions session ON session.id=appointment.session_id
      WHERE appointment.id=$1`,
    [booking.appointmentId],
  );
  return result.rows[0];
}

async function audits(booking: Booking) {
  return pool.query<{ action: string; metadata: Record<string, unknown> }>(
    `SELECT action, metadata FROM audit_events
      WHERE clinic_id=$1 AND entity_id=$2 AND action='public_guest_appointment_checked_in'
      ORDER BY occurred_at`,
    [booking.clinicId, booking.appointmentId],
  );
}

async function operations(booking: Booking) {
  return pool.query<{ operation_id: string }>(
    `SELECT operation_id FROM public_guest_check_in_operations
      WHERE credential_id=$1
      ORDER BY completed_at`,
    [booking.credentialId],
  );
}

async function expectRejectedWithoutOperationalMutation(
  service: PublicGuestBookingCheckInService,
  bearer: string,
  operationId: string,
  bookings: Booking[],
) {
  const before = await Promise.all(bookings.map((booking) => state(booking)));
  const auditCounts = await Promise.all(
    bookings.map(async (booking) => (await audits(booking)).rows.length),
  );

  await expect(service.checkIn(bearer, operationId)).rejects.toBeInstanceOf(
    PublicGuestBookingCheckInRejectedError,
  );

  const after = await Promise.all(bookings.map((booking) => state(booking)));
  expect(after).toEqual(before);
  for (const [index, booking] of bookings.entries()) {
    expect((await audits(booking)).rows).toHaveLength(auditCounts[index]!);
  }
}

describe('WU62/WU65 public guest booking check-in', () => {
  it('atomically checks in once, increments the session version, emits one privacy-safe audit, and reconciles a same-operationId replay', async () => {
    const booking = await createBooking('1001');
    await openSession(booking);
    const service = new PublicGuestBookingCheckInService(pool, () => now);
    const before = await state(booking);
    await expect(service.checkIn(booking.bearer, 'op-1001-a')).resolves.toEqual(
      { status: 'checked_in', reconciled: false },
    );
    const after = await state(booking);
    expect(after).toMatchObject({
      appointment_status: 'checked_in',
      queue_state: 'checked_in',
    });
    expect(Number(after?.eligibility_order)).toBeGreaterThan(0);
    expect(Number(after?.queue_order_version)).toBe(
      Number(before?.queue_order_version) + 1,
    );
    const rows = (await audits(booking)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({
      appointmentFrom: 'confirmed',
      appointmentTo: 'checked_in',
      queueFrom: 'waiting',
      queueTo: 'checked_in',
      authority: 'guest_capability',
    });
    const serialized = JSON.stringify(rows[0]);
    for (const forbidden of [
      booking.bearer,
      booking.privateDisplayName,
      booking.contactPhone,
      booking.doctorId,
      booking.sessionId,
      booking.queueEntryId,
      'op-1001-a',
    ])
      expect(serialized).not.toContain(forbidden);

    // Same operationId reconciles to the same outcome without repeating effects.
    await expect(service.checkIn(booking.bearer, 'op-1001-a')).resolves.toEqual(
      { status: 'checked_in', reconciled: true },
    );
    expect(await state(booking)).toEqual(after);
    expect((await audits(booking)).rows).toHaveLength(1);

    // A genuinely new operationId against an already-checked-in booking is
    // an ineligible lifecycle state, not a silent success.
    await expect(
      service.checkIn(booking.bearer, 'op-1001-b'),
    ).rejects.toBeInstanceOf(PublicGuestBookingCheckInRejectedError);
    expect(await state(booking)).toEqual(after);
    expect((await audits(booking)).rows).toHaveLength(1);
  });

  it('reuses the same operationId after a simulated ambiguous transport failure and reconciles once', async () => {
    const booking = await createBooking('1101');
    await openSession(booking);
    const service = new PublicGuestBookingCheckInService(pool, () => now);

    // The mutation commits durably server-side; the client is simulated to
    // have lost visibility of the response by simply not asserting on it
    // here and retrying with the identical operationId, exactly as the
    // WU65 contract requires for an ambiguous-failure retry.
    await service.checkIn(booking.bearer, 'op-1101-ambiguous');
    const afterFirst = await state(booking);

    await expect(
      service.checkIn(booking.bearer, 'op-1101-ambiguous'),
    ).resolves.toEqual({ status: 'checked_in', reconciled: true });
    expect(await state(booking)).toEqual(afterFirst);
    expect((await audits(booking)).rows).toHaveLength(1);
    expect((await operations(booking)).rows).toEqual([
      { operation_id: 'op-1101-ambiguous' },
    ]);
  });

  it('converges concurrent same-operationId check-ins into exactly one transition and one reconciled replay', async () => {
    const first = await createBooking('2001');
    const second = await createBooking('2002', first);
    await openSession(first);
    const service = new PublicGuestBookingCheckInService(pool, () => now);
    const before = await state(first);
    const results = await Promise.all([
      service.checkIn(first.bearer, 'op-2001-race'),
      service.checkIn(first.bearer, 'op-2001-race'),
      service.checkIn(second.bearer, 'op-2002-solo'),
    ]);
    expect(
      results
        .slice(0, 2)
        .map((result) => result.reconciled)
        .sort(),
    ).toEqual([false, true]);
    expect(results[2]).toEqual({ status: 'checked_in', reconciled: false });
    expect(await state(first)).toMatchObject({
      appointment_status: 'checked_in',
      queue_state: 'checked_in',
    });
    expect(await state(second)).toMatchObject({
      appointment_status: 'checked_in',
      queue_state: 'checked_in',
    });
    expect(Number((await state(first))?.queue_order_version)).toBe(
      Number(before?.queue_order_version) + 2,
    );
    expect((await audits(first)).rows).toHaveLength(1);
    expect((await audits(second)).rows).toHaveLength(1);
    expect((await operations(first)).rows).toEqual([
      { operation_id: 'op-2001-race' },
    ]);
  });

  it('converges concurrent distinct-operationId races on one eligible booking into exactly one transition', async () => {
    const booking = await createBooking('2011');
    await openSession(booking);
    const service = new PublicGuestBookingCheckInService(pool, () => now);
    const before = await state(booking);

    const outcomes = await Promise.allSettled([
      service.checkIn(booking.bearer, 'op-2011-first'),
      service.checkIn(booking.bearer, 'op-2011-second'),
    ]);
    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome) => outcome.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<unknown>).value).toEqual({
      status: 'checked_in',
      reconciled: false,
    });
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      PublicGuestBookingCheckInRejectedError,
    );

    expect(await state(booking)).toMatchObject({
      appointment_status: 'checked_in',
      queue_state: 'checked_in',
    });
    expect(Number((await state(booking))?.queue_order_version)).toBe(
      Number(before?.queue_order_version) + 1,
    );
    expect((await audits(booking)).rows).toHaveLength(1);

    // Exactly one of the two distinct operation identities is durably
    // recorded -- both remain individually valid keys, but the
    // booking-level serialization (the same advisory lock the mutation
    // already uses) prevented both from transitioning.
    const recorded = (await operations(booking)).rows;
    expect(recorded).toHaveLength(1);
    expect(['op-2011-first', 'op-2011-second']).toContain(
      recorded[0]?.operation_id,
    );
  });

  it('keeps a capability scoped to its own booking within the same session', async () => {
    const first = await createBooking('2101');
    const second = await createBooking('2102', first);
    await openSession(first);
    const service = new PublicGuestBookingCheckInService(pool, () => now);
    const secondBefore = await state(second);
    await expect(service.checkIn(first.bearer, 'op-2101')).resolves.toEqual({
      status: 'checked_in',
      reconciled: false,
    });
    expect(await state(first)).toMatchObject({
      appointment_status: 'checked_in',
      queue_state: 'checked_in',
    });
    expect(await state(second)).toMatchObject({
      appointment_status: secondBefore?.appointment_status,
      queue_state: secondBefore?.queue_state,
      eligibility_order: secondBefore?.eligibility_order,
    });
    expect((await audits(first)).rows).toHaveLength(1);
    expect((await audits(second)).rows).toHaveLength(0);
  });

  it('rejects cross-clinic credential substitution at the database boundary', async () => {
    const source = await createBooking('2201');
    const target = await createBooking('2202');
    await openSession(source);
    await openSession(target);
    const before = await Promise.all([state(source), state(target)]);
    await expect(
      pool.query(
        `UPDATE guest_credentials
          SET clinic_id=$2, session_id=$3
        WHERE queue_entry_id=$1`,
        [source.queueEntryId, target.clinicId, target.sessionId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    expect(await Promise.all([state(source), state(target)])).toEqual(before);
    expect((await audits(source)).rows).toHaveLength(0);
    expect((await audits(target)).rows).toHaveLength(0);
  });

  it('rejects immutable patient-association drift without operational mutation', async () => {
    const booking = await createBooking('2301');
    await openSession(booking);
    const replacementPatientId = randomUUID();
    await pool.query(
      `INSERT INTO patient_operational_records (id, clinic_id, private_display_name, contact_phone) VALUES ($1, $2, 'Replacement Patient', '0555002301')`,
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
    const service = new PublicGuestBookingCheckInService(pool, () => now);
    await expectRejectedWithoutOperationalMutation(
      service,
      booking.bearer,
      'op-2301',
      [booking],
    );
  });

  it('rejects completed and no-show bookings without operational mutation', async () => {
    const service = new PublicGuestBookingCheckInService(pool, () => now);
    for (const [index, terminalState] of ['completed', 'no_show'].entries()) {
      const booking = await createBooking(`24${index + 1}1`);
      await openSession(booking);
      await pool.query(
        `UPDATE appointments SET status=$2::appointment_status WHERE id=$1`,
        [booking.appointmentId, terminalState],
      );
      if (terminalState === 'completed')
        await pool.query(
          `UPDATE queue_entries SET state='in_consultation' WHERE id=$1`,
          [booking.queueEntryId],
        );
      await pool.query(
        `UPDATE queue_entries SET state=$2::queue_entry_status WHERE id=$1`,
        [booking.queueEntryId, terminalState],
      );
      await expectRejectedWithoutOperationalMutation(
        service,
        booking.bearer,
        `op-terminal-${index}`,
        [booking],
      );
    }
  });

  it('WU66: rejects a check-in that lands after lifecycle drift from an eligible status poll, with no duplicate durable effect', async () => {
    const booking = await createBooking('6001');
    await openSession(booking);

    const { GET } = await import(
      '@/app/api/public/bookings/live-queue-status/route'
    );
    const pollResponse = await GET(
      new Request('http://localhost/api/public/bookings/live-queue-status', {
        method: 'GET',
        headers: { authorization: `Bearer ${booking.bearer}` },
      }),
    );
    expect(pollResponse.status).toBe(200);
    expect(await pollResponse.json()).toEqual({
      bookingState: 'confirmed',
      queueState: 'waiting',
      eta: null,
    });

    // Lifecycle drift between that poll and the check-in below: staff pauses
    // the session out of band.
    await pool.query(
      `UPDATE consultation_sessions SET status='paused' WHERE id=$1 AND clinic_id=$2`,
      [booking.sessionId, booking.clinicId],
    );

    const checkInResponse = await POST(
      new Request('http://localhost/api/public/bookings/check-in', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${booking.bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operationId: 'op-6001' }),
      }),
    );
    expect(checkInResponse.status).toBe(200);
    expect(await checkInResponse.json()).toEqual({
      state: 'checked_in',
      reconciled: false,
    });

    // A paused session is still an eligible check-in target (contract:
    // session status in open/paused), so this must succeed once and exactly
    // once -- proving drift within the eligible envelope produces one
    // durable effect, not zero and not a duplicate.
    expect(await state(booking)).toMatchObject({
      appointment_status: 'checked_in',
      queue_state: 'checked_in',
    });
    expect((await audits(booking)).rows).toHaveLength(1);
    expect((await operations(booking)).rows).toHaveLength(1);

    // Now drift genuinely out of eligibility (cancel the session) and prove
    // a second, distinct operationId against the same booking is rejected
    // with zero additional durable effect -- no duplicate check-in.
    await pool.query(
      `UPDATE consultation_sessions SET status='cancelled' WHERE id=$1 AND clinic_id=$2`,
      [booking.sessionId, booking.clinicId],
    );
    await expectRejectedWithoutOperationalMutation(
      new PublicGuestBookingCheckInService(pool, () => now),
      booking.bearer,
      'op-6001-distinct',
      [booking],
    );
    expect((await operations(booking)).rows).toHaveLength(1);
  });

  it('fails closed for tampered, expired, revoked, drifted, and terminal bookings with zero check-in audit', async () => {
    const service = new PublicGuestBookingCheckInService(pool, () => now);
    const tampered = await createBooking('3001');
    await openSession(tampered);
    const parts = tampered.bearer.split('.');
    await expect(
      service.checkIn(`${parts[0]}.${parts[1]}.${'A'.repeat(43)}`, 'op-3001'),
    ).rejects.toBeInstanceOf(PublicGuestBookingCheckInRejectedError);
    const expired = await createBooking('3002');
    await openSession(expired);
    await pool.query(
      `UPDATE guest_credentials SET issued_at=$2, expires_at=$3 WHERE queue_entry_id=$1`,
      [
        expired.queueEntryId,
        new Date(now.getTime() - 2000),
        new Date(now.getTime() - 1000),
      ],
    );
    await expect(
      service.checkIn(expired.bearer, 'op-3002'),
    ).rejects.toBeInstanceOf(PublicGuestBookingCheckInRejectedError);
    const revoked = await createBooking('3003');
    await openSession(revoked);
    await pool.query(
      `UPDATE guest_credentials SET revoked_at=$2 WHERE queue_entry_id=$1`,
      [revoked.queueEntryId, now],
    );
    await expect(
      service.checkIn(revoked.bearer, 'op-3003'),
    ).rejects.toBeInstanceOf(PublicGuestBookingCheckInRejectedError);
    const drifted = await createBooking('3004');
    await openSession(drifted);
    const driftPatientId = randomUUID();
    const driftQueueEntryId = randomUUID();
    await pool.query(
      `INSERT INTO patient_operational_records (id, clinic_id, private_display_name, contact_phone) VALUES ($1, $2, 'Drift Target', '0555003999')`,
      [driftPatientId, drifted.clinicId],
    );
    await pool.query(
      `INSERT INTO queue_entries (id, clinic_id, session_id, patient_id, state, source, registration_order, eligibility_order, priority_order) SELECT $1, $2, $3, $4, 'waiting', 'walk_in', COALESCE(MAX(registration_order), 0) + 1, NULL, NULL FROM queue_entries WHERE clinic_id = $2 AND session_id = $3`,
      [driftQueueEntryId, drifted.clinicId, drifted.sessionId, driftPatientId],
    );
    await pool.query(
      `UPDATE guest_credentials SET queue_entry_id=$2 WHERE queue_entry_id=$1`,
      [drifted.queueEntryId, driftQueueEntryId],
    );
    await expect(
      service.checkIn(drifted.bearer, 'op-3004'),
    ).rejects.toBeInstanceOf(PublicGuestBookingCheckInRejectedError);
    const terminal = await createBooking('3005');
    await openSession(terminal);
    await pool.query(`UPDATE appointments SET status='cancelled' WHERE id=$1`, [
      terminal.appointmentId,
    ]);
    await pool.query(`UPDATE queue_entries SET state='cancelled' WHERE id=$1`, [
      terminal.queueEntryId,
    ]);
    await expect(
      service.checkIn(terminal.bearer, 'op-3005'),
    ).rejects.toBeInstanceOf(PublicGuestBookingCheckInRejectedError);
    for (const booking of [tampered, expired, revoked, drifted, terminal])
      expect((await audits(booking)).rows).toHaveLength(0);
  });

  it('rejects a replayed operationId presented with an invalid capability without acting as an existence oracle', async () => {
    const booking = await createBooking('3101');
    await openSession(booking);
    const service = new PublicGuestBookingCheckInService(pool, () => now);
    await expect(service.checkIn(booking.bearer, 'op-3101')).resolves.toEqual({
      status: 'checked_in',
      reconciled: false,
    });

    const parts = booking.bearer.split('.');
    const tamperedSameOperationId = `${parts[0]}.${parts[1]}.${'A'.repeat(43)}`;
    await expect(
      service.checkIn(tamperedSameOperationId, 'op-3101'),
    ).rejects.toBeInstanceOf(PublicGuestBookingCheckInRejectedError);
  });

  it('rejects a malformed operationId before any resource lookup', async () => {
    const booking = await createBooking('3201');
    await openSession(booking);
    const service = new PublicGuestBookingCheckInService(pool, () => now);
    await expect(service.checkIn(booking.bearer, '')).rejects.toBeInstanceOf(
      PublicGuestBookingCheckInValidationError,
    );
    await expect(
      service.checkIn(booking.bearer, 'x'.repeat(129)),
    ).rejects.toBeInstanceOf(PublicGuestBookingCheckInValidationError);
    await expect(
      service.checkIn(booking.bearer, 'op-with-\0-nul'),
    ).rejects.toBeInstanceOf(PublicGuestBookingCheckInValidationError);
    expect(await state(booking)).toMatchObject({
      appointment_status: 'confirmed',
      queue_state: 'waiting',
    });
    expect((await audits(booking)).rows).toHaveLength(0);
  });

  it('rolls back appointment, queue/session, audit, and the idempotency record on a late injected failure, then allows exactly one subsequent execution', async () => {
    const booking = await createBooking('4001');
    await openSession(booking);
    const before = await state(booking);
    const failingService = new PublicGuestBookingCheckInService(
      pool,
      () => now,
      async () => {
        throw new Error('late failure');
      },
    );
    await expect(
      failingService.checkIn(booking.bearer, 'op-4001'),
    ).rejects.toThrow('late failure');
    expect(await state(booking)).toEqual(before);
    expect((await audits(booking)).rows).toHaveLength(0);
    expect((await operations(booking)).rows).toHaveLength(0);

    const service = new PublicGuestBookingCheckInService(pool, () => now);
    await expect(service.checkIn(booking.bearer, 'op-4001')).resolves.toEqual({
      status: 'checked_in',
      reconciled: false,
    });
    expect((await audits(booking)).rows).toHaveLength(1);
    expect((await operations(booking)).rows).toEqual([
      { operation_id: 'op-4001' },
    ]);
  });

  it('keeps the public route bearer-only, allow-listed, and matching the exact wire schema', async () => {
    const booking = await createBooking('5001');
    await openSession(booking);
    const response = await POST(
      new Request('http://localhost/api/public/bookings/check-in', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${booking.bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operationId: 'op-5001' }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ state: 'checked_in', reconciled: false });
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
      'op-5001',
    ])
      expect(serialized).not.toContain(forbidden);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('returns the generic anti-oracle rejection for a missing or invalid bearer', async () => {
    const response = await POST(
      new Request('http://localhost/api/public/bookings/check-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'op-no-bearer' }),
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'guest_check_in_unavailable',
    });
  });

  it('returns invalid_request for a missing, non-string, or malformed operationId body', async () => {
    const booking = await createBooking('5101');
    await openSession(booking);
    for (const body of [
      '{}',
      JSON.stringify({ operationId: 42 }),
      'not-json',
    ]) {
      const response = await POST(
        new Request('http://localhost/api/public/bookings/check-in', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${booking.bearer}`,
            'content-type': 'application/json',
          },
          body,
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    }
    expect((await audits(booking)).rows).toHaveLength(0);
  });

  it('reconciles a replayed request through the public route with reconciled:true', async () => {
    const booking = await createBooking('5201');
    await openSession(booking);
    const request = () =>
      POST(
        new Request('http://localhost/api/public/bookings/check-in', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${booking.bearer}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ operationId: 'op-5201' }),
        }),
      );
    const first = await request();
    expect(await first.json()).toEqual({
      state: 'checked_in',
      reconciled: false,
    });
    const second = await request();
    expect(await second.json()).toEqual({
      state: 'checked_in',
      reconciled: true,
    });
    expect((await audits(booking)).rows).toHaveLength(1);
  });
});
