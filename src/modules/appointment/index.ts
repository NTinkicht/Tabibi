import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import { type ClinicScope, requireClinicRole } from '@/modules/identity';
import { inTransaction } from '@/platform/database/transaction';

export type AppointmentStatus =
  | 'booked'
  | 'confirmed'
  | 'checked_in'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export type AppointmentContactPreference = 'none' | 'phone' | 'email';
export type AppointmentQueueState =
  | 'waiting'
  | 'checked_in'
  | 'called'
  | 'in_consultation'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export interface AppointmentBookingInput {
  patientId: string;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  contactPreference: AppointmentContactPreference;
  idempotencyKey: string;
  correlationId: string;
}

export interface AppointmentBooking {
  appointment: {
    id: string;
    clinicId: string;
    doctorId: string;
    sessionId: string;
    patientId: string;
    queueEntryId: string;
    status: AppointmentStatus;
    scheduledStartAt: string;
    scheduledEndAt: string;
    preferredLocale: 'ar' | 'fr';
    contactPreference: AppointmentContactPreference;
  };
  entry: {
    id: string;
    sessionId: string;
    state: AppointmentQueueState;
    registrationOrder: number;
    publicDisplayLabel: string;
  };
}

export class AppointmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppointmentValidationError';
  }
}

export class AppointmentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppointmentConflictError';
  }
}

function normalizeInput(input: AppointmentBookingInput) {
  if (!input.patientId)
    throw new AppointmentValidationError('Patient id is required');
  if (!input.idempotencyKey || input.idempotencyKey.length > 128)
    throw new AppointmentValidationError(
      'Idempotency key is required and must be at most 128 characters',
    );
  if (
    Number.isNaN(input.scheduledStartAt.getTime()) ||
    Number.isNaN(input.scheduledEndAt.getTime()) ||
    input.scheduledEndAt <= input.scheduledStartAt
  )
    throw new AppointmentValidationError(
      'Appointment window must have a valid start before end',
    );
  return {
    patientId: input.patientId,
    scheduledStartAt: input.scheduledStartAt,
    scheduledEndAt: input.scheduledEndAt,
    contactPreference: input.contactPreference,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
  };
}

function fingerprint(
  sessionId: string,
  input: ReturnType<typeof normalizeInput>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        sessionId,
        input.patientId,
        input.scheduledStartAt.toISOString(),
        input.scheduledEndAt.toISOString(),
        input.contactPreference,
      ]),
    )
    .digest('hex');
}

async function loadBooking(
  client: PoolClient,
  clinicId: string,
  appointmentId: string,
): Promise<AppointmentBooking> {
  const result = await client.query<{
    appointment_id: string;
    clinic_id: string;
    doctor_id: string;
    session_id: string;
    patient_id: string;
    queue_entry_id: string;
    status: AppointmentStatus;
    scheduled_start_at: Date;
    scheduled_end_at: Date;
    preferred_locale: 'ar' | 'fr';
    contact_preference: AppointmentContactPreference;
    entry_state: AppointmentQueueState;
    registration_order: string;
    public_display_label: string;
  }>(
    `SELECT appointment.id appointment_id,
            appointment.clinic_id,
            appointment.doctor_id,
            appointment.session_id,
            appointment.patient_id,
            appointment.queue_entry_id,
            appointment.status,
            appointment.scheduled_start_at,
            appointment.scheduled_end_at,
            appointment.preferred_locale,
            appointment.contact_preference,
            entry.state entry_state,
            entry.registration_order,
            entry.public_display_label
       FROM appointments appointment
       JOIN queue_entries entry
         ON entry.id = appointment.queue_entry_id
        AND entry.clinic_id = appointment.clinic_id
      WHERE appointment.id = $1 AND appointment.clinic_id = $2`,
    [appointmentId, clinicId],
  );
  const row = result.rows[0];
  if (!row)
    throw new AppointmentConflictError('Appointment booking no longer exists');
  return {
    appointment: {
      id: row.appointment_id,
      clinicId: row.clinic_id,
      doctorId: row.doctor_id,
      sessionId: row.session_id,
      patientId: row.patient_id,
      queueEntryId: row.queue_entry_id,
      status: row.status,
      scheduledStartAt: row.scheduled_start_at.toISOString(),
      scheduledEndAt: row.scheduled_end_at.toISOString(),
      preferredLocale: row.preferred_locale,
      contactPreference: row.contact_preference,
    },
    entry: {
      id: row.queue_entry_id,
      sessionId: row.session_id,
      state: row.entry_state,
      registrationOrder: Number(row.registration_order),
      publicDisplayLabel: row.public_display_label,
    },
  };
}

export class AppointmentService {
  constructor(private readonly pool: Pool) {}

  async bookForExistingPatient(
    scope: ClinicScope,
    sessionId: string,
    rawInput: AppointmentBookingInput,
  ): Promise<AppointmentBooking> {
    const input = normalizeInput(rawInput);
    const requestFingerprint = fingerprint(sessionId, input);

    return inTransaction(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          `appointment-booking:${scope.clinicId}:${scope.actorUserId}:${input.idempotencyKey}`,
        ],
      );
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);

      const receipt = await client.query<{
        request_fingerprint: string;
        appointment_id: string;
      }>(
        `SELECT request_fingerprint, appointment_id
           FROM appointment_booking_receipts
          WHERE clinic_id = $1 AND actor_user_id = $2 AND idempotency_key = $3`,
        [scope.clinicId, scope.actorUserId, input.idempotencyKey],
      );
      const existing = receipt.rows[0];
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint)
          throw new AppointmentConflictError(
            'Idempotency key was already used for a different appointment booking',
          );
        return loadBooking(client, scope.clinicId, existing.appointment_id);
      }

      const sessionResult = await client.query<{
        doctor_id: string;
        starts_at: Date;
        ends_at: Date;
        status: string;
      }>(
        `SELECT doctor_id, starts_at, ends_at, status
           FROM consultation_sessions
          WHERE id = $1 AND clinic_id = $2
          FOR UPDATE`,
        [sessionId, scope.clinicId],
      );
      const session = sessionResult.rows[0];
      if (!session)
        throw new AppointmentConflictError(
          'Consultation session was not found in this clinic',
        );
      if (!['planned', 'open', 'paused'].includes(session.status))
        throw new AppointmentConflictError(
          'Appointments cannot be booked into a terminal session',
        );
      if (
        input.scheduledStartAt < session.starts_at ||
        input.scheduledEndAt > session.ends_at
      )
        throw new AppointmentValidationError(
          'Appointment window must be contained within the consultation session',
        );

      const patientResult = await client.query<{
        preferred_locale: 'ar' | 'fr';
        contact_phone: string | null;
        contact_email: string | null;
      }>(
        `SELECT preferred_locale, contact_phone, contact_email
           FROM patient_operational_records
          WHERE id = $1 AND clinic_id = $2
          FOR SHARE`,
        [input.patientId, scope.clinicId],
      );
      const patient = patientResult.rows[0];
      if (!patient)
        throw new AppointmentConflictError(
          'Patient was not found in this clinic',
        );
      if (input.contactPreference === 'phone' && !patient.contact_phone)
        throw new AppointmentValidationError(
          'Phone contact preference requires a patient phone number',
        );
      if (input.contactPreference === 'email' && !patient.contact_email)
        throw new AppointmentValidationError(
          'Email contact preference requires a patient email address',
        );

      const orderResult = await client.query<{ next_order: string }>(
        `SELECT COALESCE(MAX(registration_order), 0) + 1 AS next_order
           FROM queue_entries
          WHERE session_id = $1`,
        [sessionId],
      );
      const registrationOrder = Number(orderResult.rows[0]?.next_order ?? '1');
      const entryId = randomUUID();
      const appointmentId = randomUUID();

      await client.query(
        `INSERT INTO queue_entries
           (id, clinic_id, session_id, patient_id, state, source, registration_order,
            eligibility_order, priority_order)
         VALUES ($1, $2, $3, $4, 'waiting', 'appointment', $5, NULL, NULL)`,
        [
          entryId,
          scope.clinicId,
          sessionId,
          input.patientId,
          registrationOrder,
        ],
      );
      await client.query(
        `INSERT INTO appointments
           (id, clinic_id, doctor_id, session_id, patient_id, queue_entry_id,
            status, scheduled_start_at, scheduled_end_at, preferred_locale,
            contact_preference, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, $8, $9, $10, 'staff')`,
        [
          appointmentId,
          scope.clinicId,
          session.doctor_id,
          sessionId,
          input.patientId,
          entryId,
          input.scheduledStartAt,
          input.scheduledEndAt,
          patient.preferred_locale,
          input.contactPreference,
        ],
      );
      await appendAuditEvent(client, {
        clinicId: scope.clinicId,
        actorUserId: scope.actorUserId,
        entityType: 'appointment',
        entityId: appointmentId,
        action: 'appointment_booked',
        metadata: {
          source: 'staff',
          status: 'confirmed',
          sessionId,
          queueEntryId: entryId,
          registrationOrder,
          preferredLocale: patient.preferred_locale,
          contactPreference: input.contactPreference,
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      await client.query(
        `INSERT INTO appointment_booking_receipts
           (clinic_id, actor_user_id, idempotency_key, request_fingerprint, appointment_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          scope.clinicId,
          scope.actorUserId,
          input.idempotencyKey,
          requestFingerprint,
          appointmentId,
        ],
      );

      return loadBooking(client, scope.clinicId, appointmentId);
    });
  }
}
