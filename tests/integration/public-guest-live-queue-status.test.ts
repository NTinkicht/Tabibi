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

/**
 * Inserts a bare queue_entries row (no appointment/receipt) in the same
 * session, so it participates in ordering/ETA-sample computation without
 * itself being independently queryable through a guest bearer. Mirrors the
 * insert shape already used by the queue-entry association drift test above.
 */
async function insertQueueEntry(
  booking: Booking,
  entryState: string,
  suffix: string,
  timing: { inConsultationStartedAt?: Date; completedAt?: Date } = {},
): Promise<string> {
  const patientId = randomUUID();
  const entryId = randomUUID();
  await pool.query(
    `INSERT INTO patient_operational_records (id, clinic_id, private_display_name, contact_phone) VALUES ($1, $2, 'Filler Patient', $3)`,
    [patientId, booking.clinicId, `+21355508${suffix.padStart(4, '0')}`],
  );
  await pool.query(
    `INSERT INTO queue_entries
      (id, clinic_id, session_id, patient_id, state, source, registration_order,
       eligibility_order, priority_order, in_consultation_started_at, completed_at)
     SELECT $1, $2, $3, $4, $5::queue_entry_status, 'walk_in',
            COALESCE(MAX(registration_order), 0) + 1, NULL, NULL, $6, $7
       FROM queue_entries WHERE clinic_id = $2 AND session_id = $3`,
    [
      entryId,
      booking.clinicId,
      booking.sessionId,
      patientId,
      entryState,
      timing.inConsultationStartedAt ?? null,
      timing.completedAt ?? null,
    ],
  );
  return entryId;
}

describe('WU63 public guest live queue status', () => {
  it("reads a valid capability's own durably bound booking and queue participation", async () => {
    const booking = await createBooking('1001');
    await openSession(booking);
    const service = new PublicGuestLiveQueueStatusService(pool, () => now);

    await expect(service.get(booking.bearer)).resolves.toEqual({
      bookingState: 'confirmed',
      queueState: 'waiting',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: null,
    });

    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu63-status-1001',
    );

    await expect(service.get(booking.bearer)).resolves.toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: {
        patientsAhead: 0,
        minWaitMinutes: 0,
        maxWaitMinutes: 0,
        estimateSource: 'fallback',
        delayStatus: null,
        revision: expect.stringMatching(/^eta-v2-[0-9a-f]{32}$/),
      },
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
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: {
        patientsAhead: 0,
        minWaitMinutes: 0,
        maxWaitMinutes: 0,
        estimateSource: 'fallback',
        delayStatus: null,
        revision: expect.stringMatching(/^eta-v2-[0-9a-f]{32}$/),
      },
    });
    await expect(service.get(second.bearer)).resolves.toEqual({
      bookingState: 'confirmed',
      queueState: 'waiting',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: null,
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
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: null,
    });
    await expect(service.get(target.bearer)).resolves.toEqual({
      bookingState: 'confirmed',
      queueState: 'waiting',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: null,
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
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: null,
    });
    await expect(service.get(cancelled.bearer)).resolves.toEqual({
      bookingState: 'cancelled',
      queueState: 'cancelled',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: null,
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
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: null,
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
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: null,
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
      {
        bookingState: 'confirmed',
        queueState: 'waiting',
        pauseStatus: null,
        closureStatus: null,
        activeConsultationRemainingMinutes: null,
        eta: null,
      },
      {
        bookingState: 'confirmed',
        queueState: 'waiting',
        pauseStatus: null,
        closureStatus: null,
        activeConsultationRemainingMinutes: null,
        eta: null,
      },
      {
        bookingState: 'confirmed',
        queueState: 'waiting',
        pauseStatus: null,
        closureStatus: null,
        activeConsultationRemainingMinutes: null,
        eta: null,
      },
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
    expect(body).toEqual({
      bookingState: 'confirmed',
      queueState: 'waiting',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: null,
    });
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

describe('WU67 public guest deterministic ETA projection', () => {
  it('declares, updates, and clears only the target session delay without exposing identity', async () => {
    const target = await createBooking('7001');
    const unrelated = await createBooking('7002');
    await openSession(target);
    await openSession(unrelated);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      target.bearer,
      'wu91-status-7001',
    );
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      unrelated.bearer,
      'wu91-status-7002',
    );

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    const original = await service.get(target.bearer);
    expect(original.eta?.delayStatus).toBeNull();

    await pool.query(
      `UPDATE consultation_sessions SET declared_delay_minutes=10, delay_updated_at=$2 WHERE id=$1`,
      [target.sessionId, now],
    );
    const declared = await service.get(target.bearer);
    expect(declared.eta?.delayStatus).toBe('declared');
    expect(declared.eta?.revision).not.toBe(original.eta?.revision);
    expect(await service.get(unrelated.bearer)).toMatchObject({
      eta: { delayStatus: null },
    });

    await pool.query(
      `UPDATE consultation_sessions SET declared_delay_minutes=25, delay_updated_at=$2 WHERE id=$1`,
      [target.sessionId, new Date(now.getTime() + 60_000)],
    );
    const updated = await service.get(target.bearer);
    expect(updated.eta?.delayStatus).toBe('declared');
    expect(updated.eta?.revision).not.toBe(declared.eta?.revision);

    await pool.query(
      `UPDATE consultation_sessions SET declared_delay_minutes=NULL, delay_updated_at=NULL WHERE id=$1`,
      [target.sessionId],
    );
    const cleared = await service.get(target.bearer);
    expect(cleared.eta?.delayStatus).toBeNull();
    expect(cleared.eta?.revision).not.toBe(updated.eta?.revision);
    expect(JSON.stringify(declared)).not.toContain(target.doctorId);
  });

  it('isolates the declared session delay from the per-entry consultation estimate', async () => {
    const booking = await createBooking('7011');
    await openSession(booking);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu67-status-7011',
    );
    await pool.query(
      `UPDATE consultation_sessions SET declared_delay_minutes=20, delay_updated_at=$2 WHERE id=$1`,
      [booking.sessionId, now],
    );

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(booking.bearer)).resolves.toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: {
        patientsAhead: 0,
        minWaitMinutes: 20,
        maxWaitMinutes: 20,
        estimateSource: 'fallback',
        delayStatus: 'declared',
        revision: expect.stringMatching(/^eta-v2-[0-9a-f]{32}$/),
      },
    });
  });

  it('stays on the fallback consultation estimate below the minimum observed-sample threshold', async () => {
    const ahead = await createBooking('7022');
    const booking = await createBooking('7021', ahead);
    await openSession(booking);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      ahead.bearer,
      'wu67-status-7022',
    );
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu67-status-7021',
    );
    await insertQueueEntry(booking, 'completed', '7023', {
      inConsultationStartedAt: new Date(now.getTime() - 10 * 60_000),
      completedAt: now,
    });
    await insertQueueEntry(booking, 'completed', '7024', {
      inConsultationStartedAt: new Date(now.getTime() - 12 * 60_000),
      completedAt: now,
    });

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(booking.bearer)).resolves.toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: {
        patientsAhead: 1,
        minWaitMinutes: Math.round(1 * 15 * 0.75),
        maxWaitMinutes: Math.round(1 * 15 * 1.5),
        estimateSource: 'fallback',
        delayStatus: null,
        revision: expect.stringMatching(/^eta-v2-[0-9a-f]{32}$/),
      },
    });
  });

  it('switches to the observed-sample median once the minimum sample threshold is met', async () => {
    const ahead = await createBooking('7032');
    const booking = await createBooking('7031', ahead);
    await openSession(booking);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      ahead.bearer,
      'wu67-status-7032',
    );
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu67-status-7031',
    );
    await insertQueueEntry(booking, 'completed', '7033', {
      inConsultationStartedAt: new Date(now.getTime() - 10 * 60_000),
      completedAt: now,
    });
    await insertQueueEntry(booking, 'completed', '7034', {
      inConsultationStartedAt: new Date(now.getTime() - 20 * 60_000),
      completedAt: now,
    });
    await insertQueueEntry(booking, 'completed', '7035', {
      inConsultationStartedAt: new Date(now.getTime() - 30 * 60_000),
      completedAt: now,
    });

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(booking.bearer)).resolves.toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: {
        patientsAhead: 1,
        minWaitMinutes: Math.round(1 * 20 * 0.75),
        maxWaitMinutes: Math.round(1 * 20 * 1.5),
        estimateSource: 'observed_median',
        delayStatus: null,
        revision: expect.stringMatching(/^eta-v2-[0-9a-f]{32}$/),
      },
    });
  });

  it('clamps extreme observed durations before taking the median', async () => {
    const ahead = await createBooking('7042');
    const booking = await createBooking('7041', ahead);
    await openSession(booking);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      ahead.bearer,
      'wu67-status-7042',
    );
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu67-status-7041',
    );
    // Unclamped raw minutes: 0.5, 1, 300 -> sorted median would be 1.
    // Clamped to [2, 120]: 2, 2, 120 -> median is 2, proving clamping is applied
    // before the median (not after), since the unclamped median (1) differs.
    await insertQueueEntry(booking, 'completed', '7043', {
      inConsultationStartedAt: new Date(now.getTime() - 30_000),
      completedAt: now,
    });
    await insertQueueEntry(booking, 'completed', '7044', {
      inConsultationStartedAt: new Date(now.getTime() - 60_000),
      completedAt: now,
    });
    await insertQueueEntry(booking, 'completed', '7045', {
      inConsultationStartedAt: new Date(now.getTime() - 300 * 60_000),
      completedAt: now,
    });

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(booking.bearer)).resolves.toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: {
        patientsAhead: 1,
        minWaitMinutes: Math.round(1 * 2 * 0.75),
        maxWaitMinutes: Math.round(1 * 2 * 1.5),
        estimateSource: 'observed_median',
        delayStatus: null,
        revision: expect.stringMatching(/^eta-v2-[0-9a-f]{32}$/),
      },
    });
  });

  it('excludes terminal entries and orders patientsAhead across live queue states', async () => {
    const booking = await createBooking('7051');
    await openSession(booking);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu67-status-7051',
    );
    await insertQueueEntry(booking, 'cancelled', '7052');
    await insertQueueEntry(booking, 'in_consultation', '7053');
    await insertQueueEntry(booking, 'called', '7054');
    await insertQueueEntry(booking, 'waiting', '7055');
    await insertQueueEntry(booking, 'no_show', '7056');

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(booking.bearer)).resolves.toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: {
        patientsAhead: 2,
        minWaitMinutes: Math.round(2 * 15 * 0.75),
        maxWaitMinutes: Math.round(2 * 15 * 1.5),
        estimateSource: 'fallback',
        delayStatus: null,
        revision: expect.stringMatching(/^eta-v2-[0-9a-f]{32}$/),
      },
    });
  });

  it('computes a live ETA for a called-state guest, not only a checked-in one', async () => {
    const booking = await createBooking('7061');
    await openSession(booking);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu67-status-7061',
    );
    await pool.query(`UPDATE queue_entries SET state='called' WHERE id=$1`, [
      booking.queueEntryId,
    ]);

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(booking.bearer)).resolves.toEqual({
      bookingState: 'checked_in',
      queueState: 'called',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: {
        patientsAhead: 0,
        minWaitMinutes: 0,
        maxWaitMinutes: 0,
        estimateSource: 'fallback',
        delayStatus: null,
        revision: expect.stringMatching(/^eta-v2-[0-9a-f]{32}$/),
      },
    });
  });

  it('keeps ETA isolated per guest capability within the same live queue', async () => {
    const first = await createBooking('7071');
    const second = await createBooking('7072', first);
    await openSession(first);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      first.bearer,
      'wu67-status-7071',
    );
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      second.bearer,
      'wu67-status-7072',
    );

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(first.bearer)).resolves.toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: {
        patientsAhead: 0,
        minWaitMinutes: 0,
        maxWaitMinutes: 0,
        estimateSource: 'fallback',
        delayStatus: null,
        revision: expect.stringMatching(/^eta-v2-[0-9a-f]{32}$/),
      },
    });
    await expect(service.get(second.bearer)).resolves.toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: {
        patientsAhead: 1,
        minWaitMinutes: Math.round(1 * 15 * 0.75),
        maxWaitMinutes: Math.round(1 * 15 * 1.5),
        estimateSource: 'fallback',
        delayStatus: null,
        revision: expect.stringMatching(/^eta-v2-[0-9a-f]{32}$/),
      },
    });
  });

  it('exposes the exact allow-listed eta shape at the route level with no extra fields', async () => {
    const booking = await createBooking('7081');
    await openSession(booking);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu67-status-7081',
    );
    const response = await GET(
      new Request('http://localhost/api/public/bookings/live-queue-status', {
        headers: { authorization: `Bearer ${booking.bearer}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: {
        patientsAhead: 0,
        minWaitMinutes: 0,
        maxWaitMinutes: 0,
        estimateSource: 'fallback',
        delayStatus: null,
        revision: expect.stringMatching(/^eta-v2-[0-9a-f]{32}$/),
        summary: {
          midpointMinutes: 0,
          uncertaintyWidthMinutes: 0,
          confidence: 'high',
        },
      },
    });
    expect(Object.keys(body.eta).sort()).toEqual(
      [
        'patientsAhead',
        'minWaitMinutes',
        'maxWaitMinutes',
        'estimateSource',
        'delayStatus',
        'revision',
        'summary',
      ].sort(),
    );
    expect(Object.keys(body.eta.summary).sort()).toEqual(
      ['midpointMinutes', 'uncertaintyWidthMinutes', 'confidence'].sort(),
    );
  });

  it('keeps queue order, declared delay, and the observed-sample threshold on one committed PostgreSQL snapshot', async () => {
    const ahead = await createBooking('7091');
    const booking = await createBooking('7092', ahead);
    await openSession(booking);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      ahead.bearer,
      'wu67-status-7091',
    );
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu67-status-7092',
    );
    await insertQueueEntry(booking, 'completed', '7093', {
      inConsultationStartedAt: new Date(now.getTime() - 10 * 60_000),
      completedAt: now,
    });
    await insertQueueEntry(booking, 'completed', '7094', {
      inConsultationStartedAt: new Date(now.getTime() - 12 * 60_000),
      completedAt: now,
    });

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    const baseline = {
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: {
        patientsAhead: 1,
        minWaitMinutes: Math.round(1 * 15 * 0.75),
        maxWaitMinutes: Math.round(1 * 15 * 1.5),
        estimateSource: 'fallback' as const,
        delayStatus: null,
        revision: expect.stringMatching(/^eta-v2-[0-9a-f]{32}$/),
      },
    };
    await expect(service.get(booking.bearer)).resolves.toEqual(baseline);

    // A single writer transaction atomically changes all three ETA input
    // categories at once: queue order/lifecycle (a new in-consultation
    // entry cuts ahead), declared delay, and the observed-duration sample
    // count (crossing the >=3 fallback -> median threshold). It is never
    // committed until after the guest projection has been re-read.
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');

      const cuttingPatientId = randomUUID();
      const cuttingEntryId = randomUUID();
      await writer.query(
        `INSERT INTO patient_operational_records (id, clinic_id, private_display_name, contact_phone) VALUES ($1, $2, 'Cutting Patient', '0555009991')`,
        [cuttingPatientId, booking.clinicId],
      );
      await writer.query(
        `INSERT INTO queue_entries
          (id, clinic_id, session_id, patient_id, state, source, registration_order,
           eligibility_order, priority_order, in_consultation_started_at, completed_at)
         SELECT $1, $2, $3, $4, 'in_consultation'::queue_entry_status, 'walk_in',
                COALESCE(MAX(registration_order), 0) + 1, NULL, NULL, now(), NULL
           FROM queue_entries WHERE clinic_id = $2 AND session_id = $3`,
        [cuttingEntryId, booking.clinicId, booking.sessionId, cuttingPatientId],
      );

      await writer.query(
        `UPDATE consultation_sessions SET declared_delay_minutes=20, delay_updated_at=$2 WHERE id=$1`,
        [booking.sessionId, now],
      );

      const thirdSamplePatientId = randomUUID();
      const thirdSampleEntryId = randomUUID();
      await writer.query(
        `INSERT INTO patient_operational_records (id, clinic_id, private_display_name, contact_phone) VALUES ($1, $2, 'Third Sample', '0555009992')`,
        [thirdSamplePatientId, booking.clinicId],
      );
      await writer.query(
        `INSERT INTO queue_entries
          (id, clinic_id, session_id, patient_id, state, source, registration_order,
           eligibility_order, priority_order, in_consultation_started_at, completed_at)
         SELECT $1, $2, $3, $4, 'completed'::queue_entry_status, 'walk_in',
                COALESCE(MAX(registration_order), 0) + 1, NULL, NULL, $5, $6
           FROM queue_entries WHERE clinic_id = $2 AND session_id = $3`,
        [
          thirdSampleEntryId,
          booking.clinicId,
          booking.sessionId,
          thirdSamplePatientId,
          new Date(now.getTime() - 20 * 60_000),
          now,
        ],
      );

      // While the writer's transaction above remains uncommitted, the guest
      // projection must be entirely the old committed snapshot -- never a
      // hybrid mixing in the new order, delay, or sample count.
      await expect(service.get(booking.bearer)).resolves.toEqual(baseline);

      await writer.query('COMMIT');
    } catch (error) {
      await writer.query('ROLLBACK');
      throw error;
    } finally {
      writer.release();
    }

    // Once committed, the projection must be entirely the new snapshot:
    // patientsAhead includes the cutting-in-consultation entry, the
    // declared delay applies, and the third sample has flipped the
    // estimate to the observed median of [10, 12, 20] = 12.
    await expect(service.get(booking.bearer)).resolves.toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: {
        patientsAhead: 2,
        minWaitMinutes: Math.round(20 + 2 * 12 * 0.75),
        maxWaitMinutes: Math.round(20 + 2 * 12 * 1.5),
        estimateSource: 'observed_median',
        delayStatus: 'declared',
        revision: expect.stringMatching(/^eta-v2-[0-9a-f]{32}$/),
      },
    });
  });
});

describe('WU88 guest active-consultation remaining time', () => {
  it('projects bounded remaining minutes only once the guest is the in-consultation entry with a committed start', async () => {
    const booking = await createBooking('8001');
    await openSession(booking);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu88-status-8001',
    );
    await pool.query(`UPDATE queue_entries SET state='called' WHERE id=$1`, [
      booking.queueEntryId,
    ]);

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(booking.bearer)).resolves.toMatchObject({
      queueState: 'called',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
    });

    await pool.query(
      `UPDATE queue_entries SET state='in_consultation', in_consultation_started_at=$2 WHERE id=$1`,
      [booking.queueEntryId, new Date(now.getTime() - 5 * 60_000)],
    );
    // No observed/historical samples exist for this clinic, so the shared
    // estimator falls back to its 15-minute default: 15 - 5 elapsed = 10.
    await expect(service.get(booking.bearer)).resolves.toMatchObject({
      bookingState: 'checked_in',
      queueState: 'in_consultation',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: 10,
    });
  });

  it('suppresses remaining time once the booking is terminal even while the queue row still reads in_consultation', async () => {
    const booking = await createBooking('8002');
    await openSession(booking);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu88-status-8002',
    );
    await pool.query(
      `UPDATE queue_entries SET state='in_consultation', in_consultation_started_at=$2 WHERE id=$1`,
      [booking.queueEntryId, new Date(now.getTime() - 3 * 60_000)],
    );
    // Mirrors a real completion's transient ordering: the appointment status
    // can flip terminal a moment before the queue row itself is updated.
    await pool.query(`UPDATE appointments SET status='completed' WHERE id=$1`, [
      booking.appointmentId,
    ]);

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(booking.bearer)).resolves.toMatchObject({
      bookingState: 'completed',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
    });
  });

  it('fails closed to null when in-consultation but the committed start timestamp is missing', async () => {
    const booking = await createBooking('8003');
    await openSession(booking);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu88-status-8003',
    );
    // The `queue_entries_consultation_timing_trigger` (0008_queue_eta_timing)
    // auto-stamps in_consultation_started_at to real now() on any UPDATE that
    // touches `state` and leaves it null, so a genuinely-missing timestamp
    // must be produced by a second UPDATE that does not include `state` in
    // its SET list (the trigger is `BEFORE UPDATE OF state`, so it does not
    // fire when that column isn't part of the update).
    await pool.query(
      `UPDATE queue_entries SET state='in_consultation' WHERE id=$1`,
      [booking.queueEntryId],
    );
    await pool.query(
      `UPDATE queue_entries SET in_consultation_started_at=NULL WHERE id=$1`,
      [booking.queueEntryId],
    );

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(booking.bearer)).resolves.toMatchObject({
      queueState: 'in_consultation',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
    });
  });

  it('resolves to a bounded zero, not null, for a future-dated committed start', async () => {
    // A future start is a distinct case from "not applicable": the service
    // still considers the entry eligible (in_consultation with a committed
    // timestamp) and delegates to the shared WU86 estimator, which itself
    // fails closed to 0 -- not null -- for startedAt > now. `null` is
    // reserved for states where the field genuinely does not apply.
    const booking = await createBooking('8004');
    await openSession(booking);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu88-status-8004',
    );
    await pool.query(
      `UPDATE queue_entries SET state='in_consultation', in_consultation_started_at=$2 WHERE id=$1`,
      [booking.queueEntryId, new Date(now.getTime() + 5 * 60_000)],
    );

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(booking.bearer)).resolves.toMatchObject({
      queueState: 'in_consultation',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: 0,
    });
  });

  it('exposes activeConsultationRemainingMinutes at the route level for an active in-consultation guest', async () => {
    const booking = await createBooking('8005');
    await openSession(booking);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      booking.bearer,
      'wu88-status-8005',
    );
    // The route constructs its service with no injected clock, so it reads
    // real wall-clock time -- unlike every other test in this suite, this
    // committed start must be relative to Date.now(), not the fixed `now`.
    await pool.query(
      `UPDATE queue_entries SET state='in_consultation', in_consultation_started_at=$2 WHERE id=$1`,
      [booking.queueEntryId, new Date(Date.now() - 5 * 60_000)],
    );

    const response = await GET(
      new Request('http://localhost/api/public/bookings/live-queue-status', {
        headers: { authorization: `Bearer ${booking.bearer}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.activeConsultationRemainingMinutes).toBe(10);
  });
});

describe('WU92 guest-safe session pause status', () => {
  it('suppresses ETA while paused, restores it after resume, and isolates unrelated sessions', async () => {
    const target = await createBooking('9201');
    const unrelated = await createBooking('9202');
    await openSession(target);
    await openSession(unrelated);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      target.bearer,
      'wu92-status-9201',
    );
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      unrelated.bearer,
      'wu92-status-9202',
    );
    const service = new PublicGuestLiveQueueStatusService(pool, () => now);

    await expect(service.get(target.bearer)).resolves.toMatchObject({
      pauseStatus: null,
      closureStatus: null,
      eta: { patientsAhead: 0 },
    });

    await pool.query(
      `UPDATE consultation_sessions SET status='paused' WHERE id=$1 AND clinic_id=$2`,
      [target.sessionId, target.clinicId],
    );
    await expect(service.get(target.bearer)).resolves.toMatchObject({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: 'paused',
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: null,
    });
    await expect(service.get(unrelated.bearer)).resolves.toMatchObject({
      pauseStatus: null,
      closureStatus: null,
      eta: { patientsAhead: 0 },
    });

    const pausedResponse = await GET(
      new Request('http://localhost/api/public/bookings/live-queue-status', {
        headers: { authorization: `Bearer ${target.bearer}` },
      }),
    );
    expect(pausedResponse.status).toBe(200);
    expect(pausedResponse.headers.get('cache-control')).toBe('no-store');
    expect(pausedResponse.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await pausedResponse.json()).toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: 'paused',
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: null,
    });

    await pool.query(
      `UPDATE consultation_sessions SET status='open' WHERE id=$1 AND clinic_id=$2`,
      [target.sessionId, target.clinicId],
    );
    await expect(service.get(target.bearer)).resolves.toMatchObject({
      pauseStatus: null,
      closureStatus: null,
      eta: { patientsAhead: 0 },
    });
  });

  it('suppresses the pause projection for terminal bookings', async () => {
    const booking = await createBooking('9203');
    await openSession(booking);
    await pool.query(
      `UPDATE consultation_sessions SET status='paused' WHERE id=$1 AND clinic_id=$2`,
      [booking.sessionId, booking.clinicId],
    );
    await pool.query(`UPDATE appointments SET status='cancelled' WHERE id=$1`, [
      booking.appointmentId,
    ]);
    await pool.query(`UPDATE queue_entries SET state='cancelled' WHERE id=$1`, [
      booking.queueEntryId,
    ]);

    await expect(
      new PublicGuestLiveQueueStatusService(pool, () => now).get(
        booking.bearer,
      ),
    ).resolves.toEqual({
      bookingState: 'cancelled',
      queueState: 'cancelled',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: null,
    });
  });
});

describe('WU93 guest-safe session closure status', () => {
  it('projects only a bounded closure status during terminal grace and isolates unrelated sessions', async () => {
    const target = await createBooking('9301');
    const unrelated = await createBooking('9302');
    await openSession(target);
    await openSession(unrelated);
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      target.bearer,
      'wu93-status-9301',
    );
    await new PublicGuestBookingCheckInService(pool, () => now).checkIn(
      unrelated.bearer,
      'wu93-status-9302',
    );
    await pool.query(
      `UPDATE consultation_sessions
          SET status='closed', closed_at=$3
        WHERE id=$1 AND clinic_id=$2`,
      [target.sessionId, target.clinicId, now],
    );

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(target.bearer)).resolves.toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: null,
      closureStatus: 'closed',
      activeConsultationRemainingMinutes: null,
      eta: null,
    });
    await expect(service.get(unrelated.bearer)).resolves.toMatchObject({
      closureStatus: null,
      eta: { patientsAhead: 0 },
    });

    const response = await GET(
      new Request('http://localhost/api/public/bookings/live-queue-status', {
        headers: { authorization: `Bearer ${target.bearer}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const body = await response.json();
    expect(body).toEqual({
      bookingState: 'checked_in',
      queueState: 'checked_in',
      pauseStatus: null,
      closureStatus: 'closed',
      activeConsultationRemainingMinutes: null,
      eta: null,
    });
    expect(Object.keys(body).sort()).toEqual([
      'activeConsultationRemainingMinutes',
      'bookingState',
      'closureStatus',
      'eta',
      'pauseStatus',
      'queueState',
    ]);
    expect(JSON.stringify(body)).not.toMatch(
      /reason|note|staff|doctor|closedAt|timestamp|patient/i,
    );
  });

  it('rejects closure snapshots outside terminal grace and never projects closure for a terminal booking', async () => {
    const expired = await createBooking('9303');
    const terminal = await createBooking('9304');
    await openSession(expired);
    await openSession(terminal);
    await pool.query(
      `UPDATE consultation_sessions SET status='closed', closed_at=$2 WHERE id=$1`,
      [expired.sessionId, new Date(now.getTime() - 15 * 60 * 1000 - 1)],
    );
    await pool.query(
      `UPDATE consultation_sessions SET status='closed', closed_at=$2 WHERE id=$1`,
      [terminal.sessionId, now],
    );
    await pool.query(`UPDATE appointments SET status='cancelled' WHERE id=$1`, [
      terminal.appointmentId,
    ]);
    await pool.query(`UPDATE queue_entries SET state='cancelled' WHERE id=$1`, [
      terminal.queueEntryId,
    ]);

    const service = new PublicGuestLiveQueueStatusService(pool, () => now);
    await expect(service.get(expired.bearer)).rejects.toBeInstanceOf(
      PublicGuestLiveQueueStatusRejectedError,
    );
    await expect(service.get(terminal.bearer)).resolves.toEqual({
      bookingState: 'cancelled',
      queueState: 'cancelled',
      pauseStatus: null,
      closureStatus: null,
      activeConsultationRemainingMinutes: null,
      eta: null,
    });
  });
});
