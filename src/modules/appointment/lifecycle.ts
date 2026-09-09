import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import {
  AppointmentConflictError,
  AppointmentValidationError,
  type AppointmentBooking,
  type AppointmentQueueState,
  type AppointmentStatus,
} from '@/modules/appointment';
import { type ClinicScope, requireClinicRole } from '@/modules/identity';
import { inTransaction } from '@/platform/database/transaction';

export type AppointmentLifecycleCommand = 'check_in' | 'cancel';

export interface AppointmentLifecycleInput {
  command: AppointmentLifecycleCommand;
  idempotencyKey: string;
  correlationId: string;
  reason?: string | null;
}

function normalizeInput(input: AppointmentLifecycleInput) {
  const reason = input.reason?.trim() || null;
  if (!input.idempotencyKey || input.idempotencyKey.length > 128)
    throw new AppointmentValidationError(
      'Idempotency key is required and must be at most 128 characters',
    );
  if (input.command === 'cancel' && !reason)
    throw new AppointmentValidationError('Cancellation reason is required');
  if (reason && reason.length > 500)
    throw new AppointmentValidationError(
      'Lifecycle reason must be at most 500 characters',
    );
  return { ...input, reason };
}

function fingerprint(
  sessionId: string,
  appointmentId: string,
  input: ReturnType<typeof normalizeInput>,
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        sessionId,
        appointmentId,
        command: input.command,
        reason: input.reason,
      }),
    )
    .digest('hex');
}

export class AppointmentLifecycleService {
  constructor(private readonly pool: Pool) {}

  async command(
    scope: ClinicScope,
    sessionId: string,
    appointmentId: string,
    rawInput: AppointmentLifecycleInput,
  ): Promise<AppointmentBooking> {
    const input = normalizeInput(rawInput);
    const requestFingerprint = fingerprint(sessionId, appointmentId, input);

    return inTransaction(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          `appointment-lifecycle:${scope.clinicId}:${scope.actorUserId}:${input.idempotencyKey}`,
        ],
      );
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);

      const receipt = await client.query<{
        request_fingerprint: string;
        response: AppointmentBooking;
      }>(
        `SELECT request_fingerprint, response
           FROM appointment_lifecycle_receipts
          WHERE clinic_id=$1 AND actor_user_id=$2 AND idempotency_key=$3`,
        [scope.clinicId, scope.actorUserId, input.idempotencyKey],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].request_fingerprint !== requestFingerprint)
          throw new AppointmentConflictError(
            'Idempotency key was already used for a different appointment lifecycle command',
          );
        return receipt.rows[0].response;
      }

      // Lock order intentionally matches queue/session terminalization paths:
      // session -> appointment -> queue entry.
      const sessionResult = await client.query<{
        doctor_id: string;
        status: string;
      }>(
        `SELECT doctor_id, status
           FROM consultation_sessions
          WHERE id=$1 AND clinic_id=$2
          FOR UPDATE`,
        [sessionId, scope.clinicId],
      );
      const session = sessionResult.rows[0];
      if (!session)
        throw new AppointmentConflictError(
          'Consultation session was not found in this clinic',
        );
      if (!['open', 'paused'].includes(session.status))
        throw new AppointmentConflictError(
          'Appointment lifecycle commands require an open or paused session',
        );

      const appointmentResult = await client.query<{
        id: string;
        clinic_id: string;
        doctor_id: string;
        session_id: string;
        patient_id: string;
        queue_entry_id: string;
        status: AppointmentStatus;
        scheduled_start_at: Date;
        scheduled_end_at: Date;
        preferred_locale: 'ar' | 'fr';
        contact_preference: 'none' | 'phone' | 'email';
      }>(
        `SELECT id, clinic_id, doctor_id, session_id, patient_id, queue_entry_id,
                status, scheduled_start_at, scheduled_end_at,
                preferred_locale, contact_preference
           FROM appointments
          WHERE id=$1 AND clinic_id=$2
          FOR UPDATE`,
        [appointmentId, scope.clinicId],
      );
      const appointment = appointmentResult.rows[0];
      if (!appointment || appointment.session_id !== sessionId)
        throw new AppointmentConflictError(
          'Appointment was not found in this clinic and session',
        );
      if (appointment.doctor_id !== session.doctor_id)
        throw new AppointmentConflictError(
          'Appointment doctor does not match the consultation session',
        );

      const entryResult = await client.query<{
        id: string;
        clinic_id: string;
        session_id: string;
        patient_id: string;
        state: AppointmentQueueState;
        source: string;
        registration_order: string;
        eligibility_order: string | null;
        priority_order: string | null;
        public_display_label: string;
      }>(
        `SELECT id, clinic_id, session_id, patient_id, state, source,
                registration_order, eligibility_order, priority_order,
                public_display_label
           FROM queue_entries
          WHERE id=$1 AND clinic_id=$2
          FOR UPDATE`,
        [appointment.queue_entry_id, scope.clinicId],
      );
      const entry = entryResult.rows[0];
      if (
        !entry ||
        entry.session_id !== sessionId ||
        entry.patient_id !== appointment.patient_id ||
        entry.source !== 'appointment'
      )
        throw new AppointmentConflictError(
          'Appointment queue linkage is invalid for this clinic and session',
        );

      const allowedAppointment: Record<
        AppointmentLifecycleCommand,
        readonly AppointmentStatus[]
      > = {
        check_in: ['booked', 'confirmed'],
        cancel: ['booked', 'confirmed', 'checked_in'],
      };
      const allowedQueue: Record<
        AppointmentLifecycleCommand,
        readonly AppointmentQueueState[]
      > = {
        check_in: ['waiting'],
        cancel: ['waiting', 'checked_in', 'called'],
      };
      if (!allowedAppointment[input.command].includes(appointment.status))
        throw new AppointmentConflictError(
          `Cannot apply ${input.command} to appointment in ${appointment.status}`,
        );
      if (!allowedQueue[input.command].includes(entry.state))
        throw new AppointmentConflictError(
          `Cannot apply ${input.command} to linked queue entry in ${entry.state}`,
        );

      let eligibilityOrder: number | null = null;
      if (input.command === 'check_in') {
        const next = await client.query<{ value: string }>(
          `SELECT COALESCE(MAX(eligibility_order), 0) + 1 AS value
             FROM queue_entries
            WHERE session_id=$1 AND clinic_id=$2`,
          [sessionId, scope.clinicId],
        );
        eligibilityOrder = Number(next.rows[0]!.value);
      }

      const targetState: AppointmentQueueState =
        input.command === 'check_in' ? 'checked_in' : 'cancelled';
      const targetStatus: AppointmentStatus =
        input.command === 'check_in' ? 'checked_in' : 'cancelled';

      await client.query(
        `UPDATE appointments
            SET status=$3::appointment_status,
                updated_at=now()
          WHERE id=$1 AND clinic_id=$2`,
        [appointment.id, scope.clinicId, targetStatus],
      );

      await client.query(
        `UPDATE queue_entries
            SET state=$4::queue_entry_status,
                eligibility_order=CASE
                  WHEN $4::queue_entry_status='checked_in' THEN $5
                  ELSE eligibility_order
                END,
                priority_order=CASE
                  WHEN $4::queue_entry_status IN ('waiting','checked_in') THEN priority_order
                  ELSE NULL
                END,
                updated_at=now()
          WHERE id=$1 AND session_id=$2 AND clinic_id=$3`,
        [entry.id, sessionId, scope.clinicId, targetState, eligibilityOrder],
      );

      if (
        input.command === 'cancel' &&
        entry.priority_order !== null &&
        ['waiting', 'checked_in'].includes(entry.state)
      ) {
        const cohort = await client.query<{ id: string }>(
          `SELECT id
             FROM queue_entries
            WHERE session_id=$1 AND clinic_id=$2
              AND state IN ('waiting','checked_in')
              AND priority_order IS NOT NULL
            ORDER BY priority_order, registration_order
            FOR UPDATE`,
          [sessionId, scope.clinicId],
        );
        const ids = cohort.rows.map((row) => row.id);
        if (ids.length) {
          await client.query(
            'UPDATE queue_entries SET priority_order=NULL WHERE id=ANY($1::uuid[])',
            [ids],
          );
          for (let index = 0; index < ids.length; index++)
            await client.query(
              'UPDATE queue_entries SET priority_order=$2,updated_at=now() WHERE id=$1',
              [ids[index], index + 1],
            );
        }
      }

      await client.query(
        `UPDATE consultation_sessions
            SET queue_order_version=queue_order_version+1,updated_at=now()
          WHERE id=$1 AND clinic_id=$2`,
        [sessionId, scope.clinicId],
      );

      const current = await client.query<{
        status: AppointmentStatus;
        state: AppointmentQueueState;
        eligibility_order: string | null;
        priority_order: string | null;
      }>(
        `SELECT appointment.status,
                entry.state,
                entry.eligibility_order,
                entry.priority_order
           FROM appointments appointment
           JOIN queue_entries entry
             ON entry.id=appointment.queue_entry_id
            AND entry.clinic_id=appointment.clinic_id
          WHERE appointment.id=$1 AND appointment.clinic_id=$2`,
        [appointmentId, scope.clinicId],
      );
      const state = current.rows[0]!;
      const response: AppointmentBooking = {
        appointment: {
          id: appointment.id,
          clinicId: appointment.clinic_id,
          doctorId: appointment.doctor_id,
          sessionId: appointment.session_id,
          patientId: appointment.patient_id,
          queueEntryId: appointment.queue_entry_id,
          status: state.status,
          scheduledStartAt: appointment.scheduled_start_at.toISOString(),
          scheduledEndAt: appointment.scheduled_end_at.toISOString(),
          preferredLocale: appointment.preferred_locale,
          contactPreference: appointment.contact_preference,
        },
        entry: {
          id: entry.id,
          sessionId: entry.session_id,
          state: state.state,
          registrationOrder: Number(entry.registration_order),
          publicDisplayLabel: entry.public_display_label,
        },
      };

      await appendAuditEvent(client, {
        clinicId: scope.clinicId,
        actorUserId: scope.actorUserId,
        entityType: 'appointment',
        entityId: appointmentId,
        action: `appointment.${input.command}`,
        metadata: {
          command: input.command,
          outcome: 'applied',
          sessionId,
          queueEntryId: entry.id,
          appointmentFrom: appointment.status,
          appointmentTo: state.status,
          queueFrom: entry.state,
          queueTo: state.state,
          reason: input.reason,
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
        },
      });

      await client.query(
        `INSERT INTO appointment_lifecycle_receipts
           (clinic_id, actor_user_id, idempotency_key, request_fingerprint,
            appointment_id, command, response)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          scope.clinicId,
          scope.actorUserId,
          input.idempotencyKey,
          requestFingerprint,
          appointmentId,
          input.command,
          JSON.stringify(response),
        ],
      );

      return response;
    });
  }
}
