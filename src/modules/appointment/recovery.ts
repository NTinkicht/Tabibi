import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import {
  AppointmentConflictError,
  AppointmentValidationError,
  type AppointmentBooking,
  type AppointmentContactPreference,
  type AppointmentQueueState,
  type AppointmentStatus,
} from '@/modules/appointment';
import { type ClinicScope, requireClinicRole } from '@/modules/identity';
import { inTransaction } from '@/platform/database/transaction';

export type AppointmentRecoveryCommand =
  | 'restore'
  | 'restore_and_check_in'
  | 'transfer';

export interface AppointmentRecoveryInput {
  command: AppointmentRecoveryCommand;
  idempotencyKey: string;
  correlationId: string;
  reason: string;
  targetSessionId?: string | null;
}

interface LockedAppointment {
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
  contact_preference: AppointmentContactPreference;
}

interface LockedEntry {
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
}

function normalizeInput(input: AppointmentRecoveryInput) {
  const reason = input.reason.trim();
  const targetSessionId = input.targetSessionId?.trim() || null;
  if (!input.idempotencyKey || input.idempotencyKey.length > 128)
    throw new AppointmentValidationError(
      'Idempotency key is required and must be at most 128 characters',
    );
  if (!reason)
    throw new AppointmentValidationError('Recovery reason is required');
  if (reason.length > 500)
    throw new AppointmentValidationError(
      'Recovery reason must be at most 500 characters',
    );
  if (input.command === 'transfer' && !targetSessionId)
    throw new AppointmentValidationError(
      'Target session is required for appointment transfer',
    );
  if (input.command !== 'transfer' && targetSessionId)
    throw new AppointmentValidationError(
      'Restore does not accept a target session',
    );
  return { ...input, reason, targetSessionId };
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
        targetSessionId: input.targetSessionId,
        reason: input.reason,
      }),
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
         ON entry.id=appointment.queue_entry_id
        AND entry.clinic_id=appointment.clinic_id
      WHERE appointment.id=$1 AND appointment.clinic_id=$2`,
    [appointmentId, clinicId],
  );
  const row = result.rows[0];
  if (!row)
    throw new AppointmentConflictError(
      'Appointment recovery result no longer exists',
    );
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

export class AppointmentRecoveryService {
  constructor(private readonly pool: Pool) {}

  async command(
    scope: ClinicScope,
    sessionId: string,
    appointmentId: string,
    rawInput: AppointmentRecoveryInput,
  ): Promise<AppointmentBooking> {
    const input = normalizeInput(rawInput);
    const requestFingerprint = fingerprint(sessionId, appointmentId, input);

    return inTransaction(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          `appointment-recovery:${scope.clinicId}:${scope.actorUserId}:${input.idempotencyKey}`,
        ],
      );
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);

      const receipt = await client.query<{
        request_fingerprint: string;
        response: AppointmentBooking;
      }>(
        `SELECT request_fingerprint, response
           FROM appointment_recovery_receipts
          WHERE clinic_id=$1 AND actor_user_id=$2 AND idempotency_key=$3`,
        [scope.clinicId, scope.actorUserId, input.idempotencyKey],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].request_fingerprint !== requestFingerprint)
          throw new AppointmentConflictError(
            'Idempotency key was already used for a different appointment recovery command',
          );
        return receipt.rows[0].response;
      }

      const sessionIds = [sessionId, input.targetSessionId]
        .filter((value): value is string => Boolean(value))
        .sort();
      const lockedSessions = new Map<
        string,
        { doctor_id: string; status: string }
      >();
      for (const id of sessionIds) {
        const result = await client.query<{
          doctor_id: string;
          status: string;
        }>(
          `SELECT doctor_id, status
             FROM consultation_sessions
            WHERE id=$1 AND clinic_id=$2
            FOR UPDATE`,
          [id, scope.clinicId],
        );
        const session = result.rows[0];
        if (!session)
          throw new AppointmentConflictError(
            'Recovery session was not found in this clinic',
          );
        lockedSessions.set(id, session);
      }

      const sourceSession = lockedSessions.get(sessionId);
      if (!sourceSession)
        throw new AppointmentConflictError(
          'Recovery session was not found in this clinic',
        );
      if (!['open', 'paused'].includes(sourceSession.status))
        throw new AppointmentConflictError(
          'Appointment recovery requires an open or paused source session',
        );

      const appointmentResult = await client.query<LockedAppointment>(
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
          'Appointment is not canonically linked to this clinic and source session',
        );
      if (appointment.doctor_id !== sourceSession.doctor_id)
        throw new AppointmentConflictError(
          'Appointment doctor does not match the source session',
        );

      const entryResult = await client.query<LockedEntry>(
        `SELECT id, clinic_id, session_id, patient_id, state, source,
                registration_order, eligibility_order, priority_order,
                public_display_label
           FROM queue_entries
          WHERE id=$1 AND clinic_id=$2
          FOR UPDATE`,
        [appointment.queue_entry_id, scope.clinicId],
      );
      const sourceEntry = entryResult.rows[0];
      if (
        !sourceEntry ||
        sourceEntry.session_id !== sessionId ||
        sourceEntry.patient_id !== appointment.patient_id ||
        sourceEntry.source !== 'appointment'
      )
        throw new AppointmentConflictError(
          'Appointment queue linkage is stale or invalid',
        );

      if (
        input.command === 'restore' ||
        input.command === 'restore_and_check_in'
      ) {
        return this.restore(
          client,
          scope,
          appointment,
          sourceEntry,
          input,
          requestFingerprint,
        );
      }

      const targetSessionId = input.targetSessionId;
      if (!targetSessionId)
        throw new AppointmentValidationError(
          'Target session is required for appointment transfer',
        );
      const targetSession = lockedSessions.get(targetSessionId);
      if (!targetSession)
        throw new AppointmentConflictError(
          'Recovery session was not found in this clinic',
        );
      return this.transfer(
        client,
        scope,
        appointment,
        sourceEntry,
        targetSession,
        input,
        requestFingerprint,
      );
    });
  }

  private async restore(
    client: PoolClient,
    scope: ClinicScope,
    appointment: LockedAppointment,
    entry: LockedEntry,
    input: ReturnType<typeof normalizeInput>,
    requestFingerprint: string,
  ): Promise<AppointmentBooking> {
    if (!['cancelled', 'no_show'].includes(appointment.status))
      throw new AppointmentConflictError(
        `Cannot restore appointment in ${appointment.status}`,
      );
    if (!['cancelled', 'no_show'].includes(entry.state))
      throw new AppointmentConflictError(
        `Cannot restore linked queue entry in ${entry.state}`,
      );
    if (appointment.status !== entry.state)
      throw new AppointmentConflictError(
        'Appointment and linked queue entry terminal states do not match',
      );

    const restoreAndCheckIn = input.command === 'restore_and_check_in';
    let eligibilityOrder: number | null = null;
    if (restoreAndCheckIn) {
      const next = await client.query<{ value: string }>(
        `SELECT COALESCE(MAX(eligibility_order),0)+1 AS value
           FROM queue_entries
          WHERE session_id=$1 AND clinic_id=$2`,
        [appointment.session_id, scope.clinicId],
      );
      const row = next.rows[0];
      if (!row)
        throw new AppointmentConflictError('Unable to allocate queue order');
      eligibilityOrder = Number(row.value);
    }
    const targetQueue: AppointmentQueueState = restoreAndCheckIn
      ? 'checked_in'
      : 'waiting';
    const targetAppointment: AppointmentStatus = restoreAndCheckIn
      ? 'checked_in'
      : 'confirmed';

    await client.query(
      `UPDATE queue_entries
          SET state=$3::queue_entry_status,
              eligibility_order=$4,
              priority_order=NULL,
              in_consultation_started_at=NULL,
              completed_at=NULL,
              updated_at=now()
        WHERE id=$1 AND clinic_id=$2`,
      [entry.id, scope.clinicId, targetQueue, eligibilityOrder],
    );
    await client.query(
      `UPDATE appointments
          SET status=$3::appointment_status, updated_at=now()
        WHERE id=$1 AND clinic_id=$2`,
      [appointment.id, scope.clinicId, targetAppointment],
    );
    await client.query(
      `UPDATE consultation_sessions
          SET queue_order_version=queue_order_version+1, updated_at=now()
        WHERE id=$1 AND clinic_id=$2`,
      [appointment.session_id, scope.clinicId],
    );

    await appendAuditEvent(client, {
      clinicId: scope.clinicId,
      actorUserId: scope.actorUserId,
      entityType: 'appointment',
      entityId: appointment.id,
      action: `appointment.${input.command}`,
      metadata: {
        reason: input.reason,
        sessionId: appointment.session_id,
        queueEntryId: entry.id,
        appointmentFrom: appointment.status,
        appointmentTo: targetAppointment,
        queueFrom: entry.state,
        queueTo: targetQueue,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const response = await loadBooking(client, scope.clinicId, appointment.id);
    await this.persistReceipt(
      client,
      scope,
      appointment.id,
      input,
      requestFingerprint,
      response,
    );
    return response;
  }

  private async compactSourcePriority(
    client: PoolClient,
    scope: ClinicScope,
    sessionId: string,
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
    if (!ids.length) return;
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

  private async transfer(
    client: PoolClient,
    scope: ClinicScope,
    appointment: LockedAppointment,
    sourceEntry: LockedEntry,
    targetSession: { doctor_id: string; status: string },
    input: ReturnType<typeof normalizeInput>,
    requestFingerprint: string,
  ): Promise<AppointmentBooking> {
    const targetSessionId = input.targetSessionId;
    if (!targetSessionId)
      throw new AppointmentValidationError(
        'Target session is required for appointment transfer',
      );
    if (targetSessionId === appointment.session_id)
      throw new AppointmentValidationError(
        'Target session must differ from the source session',
      );
    if (!['planned', 'open', 'paused'].includes(targetSession.status))
      throw new AppointmentConflictError(
        'Target session is not accepting transferred appointments',
      );
    if (targetSession.doctor_id !== appointment.doctor_id)
      throw new AppointmentConflictError(
        'Target session doctor does not match the appointment doctor',
      );
    if (!['confirmed', 'checked_in'].includes(appointment.status))
      throw new AppointmentConflictError(
        `Cannot transfer appointment in ${appointment.status}`,
      );
    if (!['waiting', 'checked_in', 'called'].includes(sourceEntry.state))
      throw new AppointmentConflictError(
        `Cannot transfer linked queue entry in ${sourceEntry.state}`,
      );

    const existingTarget = await client.query<{ id: string }>(
      `SELECT id
         FROM appointments
        WHERE clinic_id=$1 AND session_id=$2 AND patient_id=$3 AND id<>$4
        FOR UPDATE`,
      [scope.clinicId, targetSessionId, appointment.patient_id, appointment.id],
    );
    if (existingTarget.rows[0])
      throw new AppointmentConflictError(
        'Patient already has an appointment in the target session',
      );

    const targetQueue: AppointmentQueueState =
      sourceEntry.state === 'waiting' ? 'waiting' : 'checked_in';
    const targetAppointment: AppointmentStatus =
      targetQueue === 'waiting' ? 'confirmed' : 'checked_in';

    const nextRegistration = await client.query<{ value: string }>(
      `SELECT COALESCE(MAX(registration_order),0)+1 AS value
         FROM queue_entries
        WHERE session_id=$1 AND clinic_id=$2`,
      [targetSessionId, scope.clinicId],
    );
    const registrationRow = nextRegistration.rows[0];
    if (!registrationRow)
      throw new AppointmentConflictError(
        'Unable to allocate registration order',
      );
    let eligibilityOrder: number | null = null;
    if (targetQueue === 'checked_in') {
      const nextEligibility = await client.query<{ value: string }>(
        `SELECT COALESCE(MAX(eligibility_order),0)+1 AS value
           FROM queue_entries
          WHERE session_id=$1 AND clinic_id=$2`,
        [targetSessionId, scope.clinicId],
      );
      const eligibilityRow = nextEligibility.rows[0];
      if (!eligibilityRow)
        throw new AppointmentConflictError('Unable to allocate queue order');
      eligibilityOrder = Number(eligibilityRow.value);
    }

    const targetEntryId = randomUUID();
    await client.query(
      `UPDATE queue_entries
          SET state='cancelled', priority_order=NULL, updated_at=now()
        WHERE id=$1 AND clinic_id=$2`,
      [sourceEntry.id, scope.clinicId],
    );
    if (sourceEntry.priority_order !== null)
      await this.compactSourcePriority(client, scope, appointment.session_id);

    await client.query(
      `INSERT INTO queue_entries
         (id, clinic_id, session_id, patient_id, state, source,
          registration_order, eligibility_order, priority_order)
       VALUES ($1,$2,$3,$4,$5::queue_entry_status,'appointment',$6,$7,NULL)`,
      [
        targetEntryId,
        scope.clinicId,
        targetSessionId,
        appointment.patient_id,
        targetQueue,
        Number(registrationRow.value),
        eligibilityOrder,
      ],
    );
    await client.query(
      `UPDATE appointments
          SET session_id=$3,
              queue_entry_id=$4,
              status=$5::appointment_status,
              updated_at=now()
        WHERE id=$1 AND clinic_id=$2`,
      [
        appointment.id,
        scope.clinicId,
        targetSessionId,
        targetEntryId,
        targetAppointment,
      ],
    );
    await client.query(
      `UPDATE consultation_sessions
          SET queue_order_version=queue_order_version+1, updated_at=now()
        WHERE clinic_id=$1 AND id=ANY($2::uuid[])`,
      [scope.clinicId, [appointment.session_id, targetSessionId]],
    );

    await appendAuditEvent(client, {
      clinicId: scope.clinicId,
      actorUserId: scope.actorUserId,
      entityType: 'appointment',
      entityId: appointment.id,
      action: 'appointment.transfer',
      metadata: {
        reason: input.reason,
        sourceTerminalCause: 'transfer',
        sourceSessionId: appointment.session_id,
        sourceQueueEntryId: sourceEntry.id,
        targetSessionId,
        targetQueueEntryId: targetEntryId,
        appointmentFrom: appointment.status,
        appointmentTo: targetAppointment,
        queueFrom: sourceEntry.state,
        queueTo: targetQueue,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const response = await loadBooking(client, scope.clinicId, appointment.id);
    await this.persistReceipt(
      client,
      scope,
      appointment.id,
      input,
      requestFingerprint,
      response,
    );
    return response;
  }

  private async persistReceipt(
    client: PoolClient,
    scope: ClinicScope,
    appointmentId: string,
    input: ReturnType<typeof normalizeInput>,
    requestFingerprint: string,
    response: AppointmentBooking,
  ) {
    await client.query(
      `INSERT INTO appointment_recovery_receipts
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
  }
}
