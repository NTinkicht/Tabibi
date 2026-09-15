import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import { PublicGuestBookingService } from '@/modules/public-guest-booking';
import { PublicGuestBookingCheckInService } from '@/modules/public-guest-booking-check-in';
import { PublicGuestLiveQueueStatusService } from '@/modules/public-guest-live-queue-status';
import { ReceptionistDashboardService } from '@/modules/receptionist-dashboard';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const selectionSecret =
  'wu68-selection-secret-that-is-deliberately-long-enough';
const now = new Date('2099-05-01T00:00:00.000Z');
const targetStartsAt = '2099-05-15T08:00:00.000Z';
const targetEndsAt = '2099-05-15T09:00:00.000Z';

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
};

async function createBooking(
  suffix: string,
  existing?: Booking,
): Promise<Booking> {
  const clinicId = existing?.clinicId ?? randomUUID();
  const doctorId = existing?.doctorId ?? randomUUID();
  const sessionId = existing?.sessionId ?? randomUUID();

  if (!existing) {
    const doctorUserId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1,$2,'WU68 Doctor')`,
      [doctorUserId, `wu68-doctor-${doctorUserId}`],
    );
    await pool.query(
      `INSERT INTO clinics (id, tenant_key, name, status) VALUES ($1,$2,'WU68 Clinic','active')`,
      [clinicId, `wu68-clinic-${clinicId}`],
    );
    await pool.query(
      `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1,$2,'WU68 Doctor')`,
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
      [sessionId, clinicId, doctorId, targetStartsAt, targetEndsAt],
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
    startsAt: targetStartsAt,
    endsAt: targetEndsAt,
  });
  if (!selectionReference) throw new Error('WU68 selection reference not issued');

  const contactPhone = `+21355568${suffix.padStart(4, '0')}`;
  const booked = await new PublicGuestBookingService(
    pool,
    selections,
    () => now,
  ).book({
    selectionReference,
    privateDisplayName: `WU68 Guest ${suffix}`,
    contactPhone,
    contactEmail: `${suffix}@wu68.example`,
    preferredLocale: 'fr',
    contactPreference: 'phone',
    idempotencyKey: `wu68-${suffix}`,
    correlationId: `wu68-correlation-${suffix}`,
  });
  const internal = await pool.query<{ id: string; queue_entry_id: string }>(
    `SELECT appointment.id, appointment.queue_entry_id
       FROM appointments appointment
       JOIN patient_operational_records patient ON patient.id=appointment.patient_id
      WHERE appointment.clinic_id=$1 AND appointment.session_id=$2 AND patient.contact_phone=$3`,
    [clinicId, sessionId, contactPhone],
  );
  const row = internal.rows[0];
  if (!row) throw new Error('WU68 booking internals not created');

  return {
    clinicId,
    doctorId,
    sessionId,
    queueEntryId: row.queue_entry_id,
    appointmentId: row.id,
    bearer: booked.guestBearer,
  };
}

async function openAndCheckIn(...bookings: Booking[]) {
  const first = bookings[0]!;
  await pool.query(
    `UPDATE consultation_sessions SET status='open' WHERE id=$1 AND clinic_id=$2`,
    [first.sessionId, first.clinicId],
  );
  const checkIn = new PublicGuestBookingCheckInService(pool, () => now);
  for (const [index, booking] of bookings.entries()) {
    await checkIn.checkIn(booking.bearer, `wu68-check-in-${index}-${booking.appointmentId}`);
  }
}

async function createReceptionist(clinicId: string) {
  const receptionistId = randomUUID();
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,$2,'WU68 Receptionist')`,
    [receptionistId, `wu68-receptionist-${receptionistId}`],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'receptionist')`,
    [clinicId, receptionistId],
  );
  return { clinicId, actorUserId: receptionistId };
}

async function insertSession(input: {
  clinicId: string;
  doctorId: string;
  sessionId?: string;
  startsAt?: string;
  endsAt?: string;
}) {
  const sessionId = input.sessionId ?? randomUUID();
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES ($1,$2,$3,'2099-05-14',$4,$5,'closed')`,
    [
      sessionId,
      input.clinicId,
      input.doctorId,
      input.startsAt ?? '2099-05-14T08:00:00.000Z',
      input.endsAt ?? '2099-05-14T12:00:00.000Z',
    ],
  );
  return sessionId;
}

async function insertDurationEntry(input: {
  clinicId: string;
  sessionId: string;
  durationMinutes: number;
  completedAt: Date;
  entryId?: string;
}) {
  const patientId = randomUUID();
  const entryId = input.entryId ?? randomUUID();
  await pool.query(
    `INSERT INTO patient_operational_records
      (id, clinic_id, private_display_name, contact_phone)
     VALUES ($1,$2,'WU68 Historical Patient',$3)`,
    [patientId, input.clinicId, `+213555${patientId.replaceAll('-', '').slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO queue_entries
      (id, clinic_id, session_id, patient_id, state, source, registration_order,
       eligibility_order, priority_order, in_consultation_started_at, completed_at)
     SELECT $1,$2,$3,$4,'completed'::queue_entry_status,'walk_in',
            COALESCE(MAX(registration_order),0)+1,NULL,NULL,$5,$6
       FROM queue_entries
      WHERE clinic_id=$2 AND session_id=$3`,
    [
      entryId,
      input.clinicId,
      input.sessionId,
      patientId,
      new Date(input.completedAt.getTime() - input.durationMinutes * 60_000),
      input.completedAt,
    ],
  );
  return entryId;
}

async function etaPair(booking: Booking, receptionistScope: Awaited<ReturnType<typeof createReceptionist>>) {
  const guest = await new PublicGuestLiveQueueStatusService(pool, () => now).get(
    booking.bearer,
  );
  const staff = await new ReceptionistDashboardService(pool).getSnapshot(
    receptionistScope,
    booking.sessionId,
  );
  const staffEntry = staff.entries.find((entry) => entry.id === booking.queueEntryId);
  if (!staffEntry) throw new Error('WU68 staff entry missing');
  return { guest: guest.eta, staff: staffEntry.eta };
}

describe('WU68 deterministic historical ETA prior', () => {
  it('uses the same same-clinic/same-doctor historical median in guest and staff projections', async () => {
    const ahead = await createBooking('1001');
    const booking = await createBooking('1002', ahead);
    await openAndCheckIn(ahead, booking);
    const receptionistScope = await createReceptionist(booking.clinicId);
    const historySession = await insertSession(booking);

    for (const [index, duration] of [20, 30, 40].entries()) {
      await insertDurationEntry({
        clinicId: booking.clinicId,
        sessionId: historySession,
        durationMinutes: duration,
        completedAt: new Date(`2099-05-14T10:0${index}:00.000Z`),
      });
    }

    const { guest, staff } = await etaPair(booking, receptionistScope);
    expect(guest).toEqual({
      patientsAhead: 1,
      minWaitMinutes: 23,
      maxWaitMinutes: 45,
      estimateSource: 'historical_median',
    });
    expect(staff).toEqual({
      patientsAhead: 1,
      minWaitMinutes: 23,
      maxWaitMinutes: 45,
      estimatedConsultationMinutes: 30,
      estimateSource: 'historical_median',
      observedSampleCount: 0,
    });
    expect(Object.keys(guest!).sort()).toEqual(
      ['patientsAhead', 'minWaitMinutes', 'maxWaitMinutes', 'estimateSource'].sort(),
    );
    expect(JSON.stringify(guest)).not.toContain(booking.doctorId);
    expect(JSON.stringify(guest)).not.toContain(historySession);
  });

  it('keeps same-session observed evidence ahead of an available historical prior', async () => {
    const ahead = await createBooking('2001');
    const booking = await createBooking('2002', ahead);
    await openAndCheckIn(ahead, booking);
    const receptionistScope = await createReceptionist(booking.clinicId);
    const historySession = await insertSession(booking);

    for (const duration of [40, 50, 60]) {
      await insertDurationEntry({
        clinicId: booking.clinicId,
        sessionId: historySession,
        durationMinutes: duration,
        completedAt: new Date('2099-05-14T10:00:00.000Z'),
      });
    }
    for (const duration of [8, 10, 12]) {
      await insertDurationEntry({
        clinicId: booking.clinicId,
        sessionId: booking.sessionId,
        durationMinutes: duration,
        completedAt: new Date('2099-05-15T08:30:00.000Z'),
      });
    }

    const { guest, staff } = await etaPair(booking, receptionistScope);
    expect(guest).toEqual({
      patientsAhead: 1,
      minWaitMinutes: 8,
      maxWaitMinutes: 15,
      estimateSource: 'observed_median',
    });
    expect(staff).toMatchObject({
      estimatedConsultationMinutes: 10,
      estimateSource: 'observed_median',
      observedSampleCount: 3,
      minWaitMinutes: 8,
      maxWaitMinutes: 15,
    });
  });

  it('excludes other-clinic, other-doctor, and at-or-after-target-start history and preserves fallback', async () => {
    const ahead = await createBooking('3001');
    const booking = await createBooking('3002', ahead);
    await openAndCheckIn(ahead, booking);
    const receptionistScope = await createReceptionist(booking.clinicId);

    const validHistorySession = await insertSession(booking);
    for (const duration of [8, 10]) {
      await insertDurationEntry({
        clinicId: booking.clinicId,
        sessionId: validHistorySession,
        durationMinutes: duration,
        completedAt: new Date('2099-05-14T10:00:00.000Z'),
      });
    }

    const otherDoctorUser = randomUUID();
    const otherDoctor = randomUUID();
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES($1,$2,'Other Doctor')`,
      [otherDoctorUser, `wu68-other-doctor-${otherDoctorUser}`],
    );
    await pool.query(
      `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Other Doctor')`,
      [otherDoctor, otherDoctorUser],
    );
    await pool.query(
      `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
      [booking.clinicId, otherDoctor],
    );
    const otherDoctorSession = await insertSession({
      clinicId: booking.clinicId,
      doctorId: otherDoctor,
    });

    const otherClinic = randomUUID();
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name,status) VALUES($1,$2,'Other Clinic','active')`,
      [otherClinic, `wu68-other-clinic-${otherClinic}`],
    );
    await pool.query(
      `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
      [otherClinic, booking.doctorId],
    );
    const otherClinicSession = await insertSession({
      clinicId: otherClinic,
      doctorId: booking.doctorId,
    });

    const lateSameDoctorSession = await insertSession(booking);
    for (let index = 0; index < 3; index++) {
      await insertDurationEntry({
        clinicId: booking.clinicId,
        sessionId: otherDoctorSession,
        durationMinutes: 120,
        completedAt: new Date(`2099-05-14T11:0${index}:00.000Z`),
      });
      await insertDurationEntry({
        clinicId: otherClinic,
        sessionId: otherClinicSession,
        durationMinutes: 120,
        completedAt: new Date(`2099-05-14T11:1${index}:00.000Z`),
      });
      await insertDurationEntry({
        clinicId: booking.clinicId,
        sessionId: lateSameDoctorSession,
        durationMinutes: 120,
        completedAt: new Date(
          new Date(targetStartsAt).getTime() + index * 60_000,
        ),
      });
    }

    const { guest, staff } = await etaPair(booking, receptionistScope);
    expect(guest).toEqual({
      patientsAhead: 1,
      minWaitMinutes: 11,
      maxWaitMinutes: 23,
      estimateSource: 'fallback',
    });
    expect(staff).toMatchObject({
      estimatedConsultationMinutes: 15,
      estimateSource: 'fallback',
      observedSampleCount: 0,
    });
  });

  it('caps history at the deterministic 20-row completed-at/id boundary before taking the median', async () => {
    const ahead = await createBooking('4001');
    const booking = await createBooking('4002', ahead);
    await openAndCheckIn(ahead, booking);
    const receptionistScope = await createReceptionist(booking.clinicId);
    const historySession = await insertSession(booking);
    const completedAt = new Date('2099-05-14T10:00:00.000Z');

    // All 21 rows tie on completed_at. id DESC must retain 002..021 and
    // exclude 001. The retained 20 rows are ten 10-minute and ten 20-minute
    // samples => median 15. Including the excluded 120-minute row would make
    // the 21-row median 20, so this proves both the cap and the tie-break.
    for (let index = 1; index <= 21; index++) {
      const entryId = `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
      const durationMinutes = index === 1 ? 120 : index <= 11 ? 10 : 20;
      await insertDurationEntry({
        clinicId: booking.clinicId,
        sessionId: historySession,
        durationMinutes,
        completedAt,
        entryId,
      });
    }

    const { guest, staff } = await etaPair(booking, receptionistScope);
    expect(guest).toEqual({
      patientsAhead: 1,
      minWaitMinutes: 11,
      maxWaitMinutes: 23,
      estimateSource: 'historical_median',
    });
    expect(staff).toMatchObject({
      estimatedConsultationMinutes: 15,
      estimateSource: 'historical_median',
      observedSampleCount: 0,
      minWaitMinutes: 11,
      maxWaitMinutes: 23,
    });
  });
});
