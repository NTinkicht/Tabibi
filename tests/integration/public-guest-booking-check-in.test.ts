import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/public/bookings/check-in/route';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import { PublicGuestBookingService } from '@/modules/public-guest-booking';
import {
  PublicGuestBookingCheckInRejectedError,
  PublicGuestBookingCheckInService,
} from '@/modules/public-guest-booking-check-in';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const selectionSecret =
  'wu62-selection-secret-that-is-deliberately-long-enough';
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

async function expectRejectedWithoutOperationalMutation(
  service: PublicGuestBookingCheckInService,
  bearer: string,
  bookings: Booking[],
) {
  const before = await Promise.all(bookings.map((booking) => state(booking)));
  const auditCounts = await Promise.all(
    bookings.map(async (booking) => (await audits(booking)).rows.length),
  );

  await expect(service.checkIn(bearer)).rejects.toBeInstanceOf(
    PublicGuestBookingCheckInRejectedError,
  );

  const after = await Promise.all(bookings.map((booking) => state(booking)));
  expect(after).toEqual(before);
  for (const [index, booking] of bookings.entries()) {
    expect((await audits(booking)).rows).toHaveLength(auditCounts[index]!);
  }
}

describe('WU62 public guest booking check-in', () => {
  it('atomically checks in once, increments the session version, and emits one privacy-safe audit', async () => {
    const booking = await createBooking('1001');
    await openSession(booking);
    const service = new PublicGuestBookingCheckInService(pool, () => now);
    const before = await state(booking);
    await expect(service.checkIn(booking.bearer)).resolves.toEqual({
      status: 'checked_in',
    });
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
    ])
      expect(serialized).not.toContain(forbidden);
    await expect(service.checkIn(booking.bearer)).resolves.toEqual({
      status: 'checked_in',
    });
    expect(await state(booking)).toEqual(after);
    expect((await audits(booking)).rows).toHaveLength(1);
  });

  it('converges duplicate and same-session concurrent check-ins without duplicate audits', async () => {
    const first = await createBooking('2001');
    const second = await createBooking('2002', first);
    await openSession(first);
    const service = new PublicGuestBookingCheckInService(pool, () => now);
    const before = await state(first);
    await expect(
      Promise.all([
        service.checkIn(first.bearer),
        service.checkIn(first.bearer),
        service.checkIn(second.bearer),
      ]),
    ).resolves.toEqual([
      { status: 'checked_in' },
      { status: 'checked_in' },
      { status: 'checked_in' },
    ]);
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
  });

  it('keeps a capability scoped to its own booking within the same session', async () => {
    const first = await createBooking('2101');
    const second = await createBooking('2102', first);
    await openSession(first);
    const service = new PublicGuestBookingCheckInService(pool, () => now);
    const secondBefore = await state(second);

    await expect(service.checkIn(first.bearer)).resolves.toEqual({
      status: 'checked_in',
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

  it('rejects cross-clinic credential substitution without operational mutation', async () => {
    const source = await createBooking('2201');
    const target = await createBooking('2202');
    await openSession(source);
    await openSession(target);
    const service = new PublicGuestBookingCheckInService(pool, () => now);

    await pool.query(
      `UPDATE guest_credentials SET revoked_at=$2 WHERE queue_entry_id=$1`,
      [target.queueEntryId, now],
    );
    await pool.query(
      `UPDATE guest_credentials
          SET clinic_id=$2, session_id=$3, queue_entry_id=$4
        WHERE queue_entry_id=$1`,
      [source.queueEntryId, target.clinicId, target.sessionId, target.queueEntryId],
    );

    await expectRejectedWithoutOperationalMutation(service, source.bearer, [
      source,
      target,
    ]);
  });

  it('rejects immutable patient-association drift without operational mutation', async () => {
    const booking = await createBooking('2301');
    await openSession(booking);
    const replacementPatientId = randomUUID();
    await pool.query(
      `INSERT INTO patient_operational_records
         (id, clinic_id, private_display_name, contact_phone)
       VALUES ($1, $2, 'Replacement Patient', '0555002301')`,
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
    await expectRejectedWithoutOperationalMutation(service, booking.bearer, [
      booking,
    ]);
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
      await pool.query(
        `UPDATE queue_entries
            SET state=$2::queue_entry_status,
                completed_at=CASE WHEN $2='completed' THEN now() ELSE completed_at END
          WHERE id=$1`,
        [booking.queueEntryId, terminalState],
      );

      await expectRejectedWithoutOperationalMutation(service, booking.bearer, [
        booking,
      ]);
    }
  });

  it('fails closed for tampered, expired, revoked, drifted, and terminal bookings with zero check-in audit', async () => {
    const service = new PublicGuestBookingCheckInService(pool, () => now);
    const tampered = await createBooking('3001');
    await openSession(tampered);
    const parts = tampered.bearer.split('.');
    await expect(
      service.checkIn(`${parts[0]}.${parts[1]}.${'A'.repeat(43)}`),
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
    await expect(service.checkIn(expired.bearer)).rejects.toBeInstanceOf(
      PublicGuestBookingCheckInRejectedError,
    );

    const revoked = await createBooking('3003');
    await openSession(revoked);
    await pool.query(
      `UPDATE guest_credentials SET revoked_at=$2 WHERE queue_entry_id=$1`,
      [revoked.queueEntryId, now],
    );
    await expect(service.checkIn(revoked.bearer)).rejects.toBeInstanceOf(
      PublicGuestBookingCheckInRejectedError,
    );

    const drifted = await createBooking('3004');
    await openSession(drifted);
    const driftPatientId = randomUUID();
    const driftQueueEntryId = randomUUID();
    await pool.query(
      `INSERT INTO patient_operational_records
         (id, clinic_id, private_display_name, contact_phone)
       VALUES ($1, $2, 'Drift Target', '0555003999')`,
      [driftPatientId, drifted.clinicId],
    );
    await pool.query(
      `INSERT INTO queue_entries
         (id, clinic_id, session_id, patient_id, state, source, registration_order,
          eligibility_order, priority_order)
       SELECT $1, $2, $3, $4, 'waiting', 'walk_in',
              COALESCE(MAX(registration_order), 0) + 1, NULL, NULL
         FROM queue_entries
        WHERE clinic_id = $2 AND session_id = $3`,
      [driftQueueEntryId, drifted.clinicId, drifted.sessionId, driftPatientId],
    );
    await pool.query(
      `UPDATE guest_credentials SET queue_entry_id=$2 WHERE queue_entry_id=$1`,
      [drifted.queueEntryId, driftQueueEntryId],
    );
    await expect(service.checkIn(drifted.bearer)).rejects.toBeInstanceOf(
      PublicGuestBookingCheckInRejectedError,
    );

    const terminal = await createBooking('3005');
    await openSession(terminal);
    await pool.query(`UPDATE appointments SET status='cancelled' WHERE id=$1`, [
      terminal.appointmentId,
    ]);
    await pool.query(`UPDATE queue_entries SET state='cancelled' WHERE id=$1`, [
      terminal.queueEntryId,
    ]);
    await expect(service.checkIn(terminal.bearer)).rejects.toBeInstanceOf(
      PublicGuestBookingCheckInRejectedError,
    );

    for (const booking of [tampered, expired, revoked, drifted, terminal])
      expect((await audits(booking)).rows).toHaveLength(0);
  });

  it('rolls back appointment, queue/session, and audit on a late injected failure', async () => {
    const booking = await createBooking('4001');
    await openSession(booking);
    const before = await state(booking);
    const service = new PublicGuestBookingCheckInService(
      pool,
      () => now,
      async () => {
        throw new Error('late failure');
      },
    );
    await expect(service.checkIn(booking.bearer)).rejects.toThrow(
      'late failure',
    );
    expect(await state(booking)).toEqual(before);
    expect((await audits(booking)).rows).toHaveLength(0);
  });

  it('keeps the public route bearer-only and serialization allow-listed', async () => {
    const booking = await createBooking('5001');
    await openSession(booking);
    const response = await POST(
      new Request('http://localhost/api/public/bookings/check-in', {
        method: 'POST',
        headers: { authorization: `Bearer ${booking.bearer}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: 'checked_in' });
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
});