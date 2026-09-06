import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import { type ClinicScope, requireClinicRole } from '@/modules/identity';
import { inTransaction } from '@/platform/database/transaction';

export type QueueEntryState =
  | 'waiting'
  | 'checked_in'
  | 'called'
  | 'in_consultation'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export interface WalkInRegistrationInput {
  privateDisplayName: string;
  contactPhone?: string | null;
  contactEmail?: string | null;
  preferredLocale: 'ar' | 'fr';
  idempotencyKey: string;
  correlationId: string;
}

export interface WalkInRegistration {
  patient: {
    id: string;
    privateDisplayName: string;
    preferredLocale: 'ar' | 'fr';
    hasContact: boolean;
  };
  entry: {
    id: string;
    sessionId: string;
    state: QueueEntryState;
    registrationOrder: number;
    eligibilityOrder: number | null;
    priorityOrder: number | null;
    publicDisplayLabel: string;
  };
}

export interface StaffWaitingEntry {
  id: string;
  sessionId: string;
  state: QueueEntryState;
  registrationOrder: number;
  publicDisplayLabel: string;
  privateDisplayName: string;
  preferredLocale: 'ar' | 'fr';
  hasContact: boolean;
}

export type QueueCommand =
  | 'check_in'
  | 'call'
  | 'no_show'
  | 'cancel'
  | 'start_consultation'
  | 'complete_consultation';

export interface StaffQueueEntry extends StaffWaitingEntry {
  eligibilityOrder: number | null;
  priorityOrder: number | null;
  serviceOrder: number | null;
}

export interface QueueReorderInput {
  targetPosition: number;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface QueueReorderResult {
  entry: StaffQueueEntry;
  queueOrderVersion: number;
  orderedEntryIds: string[];
}

export interface QueueCommandInput {
  command: QueueCommand;
  reason?: string;
  cancellationSource?: 'patient' | 'clinic';
  idempotencyKey: string;
  correlationId: string;
}

export class QueueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueValidationError';
  }
}

export class QueueConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueConflictError';
  }
}

function normalizeOptional(value?: string | null): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function normalizeEmail(value?: string | null): string | null {
  const email = normalizeOptional(value);
  if (!email) return null;
  const separator = email.lastIndexOf('@');
  if (separator < 0) return email;
  return `${email.slice(0, separator)}@${email.slice(separator + 1).toLowerCase()}`;
}

function normalizeInput(input: WalkInRegistrationInput) {
  const privateDisplayName = input.privateDisplayName.trim();
  if (privateDisplayName.length < 1 || privateDisplayName.length > 120)
    throw new QueueValidationError(
      'Walk-in name must be between 1 and 120 characters',
    );
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 128)
    throw new QueueValidationError(
      'Idempotency key is required and must be at most 128 characters',
    );
  const contactPhone = normalizeOptional(input.contactPhone);
  // SMTP local parts can be case-sensitive; only the DNS domain is canonical.
  const contactEmail = normalizeEmail(input.contactEmail);
  if (contactPhone && (contactPhone.length < 3 || contactPhone.length > 32))
    throw new QueueValidationError(
      'Contact phone must be between 3 and 32 characters',
    );
  if (contactEmail && (contactEmail.length < 3 || contactEmail.length > 254))
    throw new QueueValidationError(
      'Contact email must be between 3 and 254 characters',
    );
  return {
    privateDisplayName,
    contactPhone,
    contactEmail,
    preferredLocale: input.preferredLocale,
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
        input.privateDisplayName,
        input.contactPhone,
        input.contactEmail,
        input.preferredLocale,
      ]),
    )
    .digest('hex');
}

function publicDisplayLabel(entryId: string): string {
  return `W-${entryId.replaceAll('-', '').slice(0, 10).toUpperCase()}`;
}

async function loadRegistration(
  db: PoolClient,
  clinicId: string,
  patientId: string,
  entryId: string,
): Promise<WalkInRegistration> {
  const result = await db.query<{
    patient_id: string;
    private_display_name: string;
    preferred_locale: 'ar' | 'fr';
    contact_phone: string | null;
    contact_email: string | null;
    entry_id: string;
    session_id: string;
    state: QueueEntryState;
    registration_order: string;
    eligibility_order: string | null;
    priority_order: string | null;
    public_display_label: string;
  }>(
    `SELECT patient.id patient_id,
            patient.private_display_name,
            patient.preferred_locale,
            patient.contact_phone,
            patient.contact_email,
            entry.id entry_id,
            entry.session_id,
            entry.state,
            entry.registration_order,
            entry.eligibility_order,
            entry.priority_order,
            entry.public_display_label
       FROM patient_operational_records patient
       JOIN queue_entries entry
         ON entry.patient_id = patient.id AND entry.clinic_id = patient.clinic_id
      WHERE patient.clinic_id = $1 AND patient.id = $2 AND entry.id = $3`,
    [clinicId, patientId, entryId],
  );
  const row = result.rows[0];
  if (!row)
    throw new QueueConflictError('Walk-in registration no longer exists');
  return {
    patient: {
      id: row.patient_id,
      privateDisplayName: row.private_display_name,
      preferredLocale: row.preferred_locale,
      hasContact: row.contact_phone !== null || row.contact_email !== null,
    },
    entry: {
      id: row.entry_id,
      sessionId: row.session_id,
      state: row.state,
      registrationOrder: Number(row.registration_order),
      eligibilityOrder:
        row.eligibility_order === null ? null : Number(row.eligibility_order),
      priorityOrder:
        row.priority_order === null ? null : Number(row.priority_order),
      publicDisplayLabel: row.public_display_label,
    },
  };
}

export class QueueService {
  constructor(private readonly pool: Pool) {}

  async registerWalkIn(
    scope: ClinicScope,
    sessionId: string,
    rawInput: WalkInRegistrationInput,
  ): Promise<WalkInRegistration> {
    const input = normalizeInput(rawInput);
    const requestFingerprint = fingerprint(sessionId, input);
    return inTransaction(this.pool, async (client) => {
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [
          `queue-registration:${scope.clinicId}:${scope.actorUserId}:${input.idempotencyKey}`,
        ],
      );
      const receipt = await client.query<{
        request_fingerprint: string;
        patient_id: string;
        queue_entry_id: string;
      }>(
        `SELECT request_fingerprint, patient_id, queue_entry_id
           FROM queue_registration_receipts
          WHERE clinic_id = $1 AND actor_user_id = $2 AND idempotency_key = $3`,
        [scope.clinicId, scope.actorUserId, input.idempotencyKey],
      );
      const existing = receipt.rows[0];
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint)
          throw new QueueConflictError(
            'Idempotency key was already used for a different walk-in registration',
          );
        return loadRegistration(
          client,
          scope.clinicId,
          existing.patient_id,
          existing.queue_entry_id,
        );
      }

      const session = await client.query<{ status: string }>(
        `SELECT status
           FROM consultation_sessions
          WHERE id = $1 AND clinic_id = $2
          FOR UPDATE`,
        [sessionId, scope.clinicId],
      );
      const status = session.rows[0]?.status;
      if (!status)
        throw new QueueConflictError(
          'Consultation session was not found in this clinic',
        );
      if (!['planned', 'open', 'paused'].includes(status))
        throw new QueueConflictError(
          'Walk-in registration is not allowed for a terminal session',
        );

      const orderResult = await client.query<{ next_order: string }>(
        `SELECT COALESCE(MAX(registration_order), 0) + 1 AS next_order
           FROM queue_entries
          WHERE session_id = $1`,
        [sessionId],
      );
      const registrationOrder = Number(orderResult.rows[0]?.next_order ?? '1');
      const patientId = randomUUID();
      const entryId = randomUUID();
      const label = publicDisplayLabel(entryId);

      await client.query(
        `INSERT INTO patient_operational_records
           (id, clinic_id, private_display_name, contact_phone, contact_email, preferred_locale)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          patientId,
          scope.clinicId,
          input.privateDisplayName,
          input.contactPhone,
          input.contactEmail,
          input.preferredLocale,
        ],
      );
      await client.query(
        `INSERT INTO queue_entries
           (id, clinic_id, session_id, patient_id, state, source, registration_order,
            eligibility_order, priority_order, public_display_label)
         VALUES ($1, $2, $3, $4, 'waiting', 'walk_in', $5, NULL, NULL, $6)`,
        [
          entryId,
          scope.clinicId,
          sessionId,
          patientId,
          registrationOrder,
          label,
        ],
      );
      await appendAuditEvent(client, {
        clinicId: scope.clinicId,
        actorUserId: scope.actorUserId,
        entityType: 'queue_entry',
        entityId: entryId,
        action: 'walk_in_registered',
        metadata: {
          source: 'walk_in',
          state: 'waiting',
          registrationOrder,
          hasContact:
            input.contactPhone !== null || input.contactEmail !== null,
          preferredLocale: input.preferredLocale,
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      await client.query(
        `INSERT INTO queue_registration_receipts
           (clinic_id, actor_user_id, idempotency_key, request_fingerprint, patient_id, queue_entry_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          scope.clinicId,
          scope.actorUserId,
          input.idempotencyKey,
          requestFingerprint,
          patientId,
          entryId,
        ],
      );
      return loadRegistration(client, scope.clinicId, patientId, entryId);
    });
  }

  async listWaiting(
    scope: ClinicScope,
    sessionId: string,
  ): Promise<StaffWaitingEntry[]> {
    return inTransaction(this.pool, async (client) => {
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);
      const session = await client.query(
        `SELECT 1 FROM consultation_sessions WHERE id = $1 AND clinic_id = $2`,
        [sessionId, scope.clinicId],
      );
      if (session.rowCount !== 1)
        throw new QueueConflictError(
          'Consultation session was not found in this clinic',
        );
      const result = await client.query<{
        id: string;
        session_id: string;
        state: QueueEntryState;
        registration_order: string;
        public_display_label: string;
        private_display_name: string;
        preferred_locale: 'ar' | 'fr';
        contact_phone: string | null;
        contact_email: string | null;
      }>(
        `SELECT entry.id,
                entry.session_id,
                entry.state,
                entry.registration_order,
                entry.public_display_label,
                patient.private_display_name,
                patient.preferred_locale,
                patient.contact_phone,
                patient.contact_email
           FROM queue_entries entry
           JOIN patient_operational_records patient
             ON patient.id = entry.patient_id AND patient.clinic_id = entry.clinic_id
          WHERE entry.clinic_id = $1 AND entry.session_id = $2 AND entry.state = 'waiting'
          ORDER BY entry.registration_order`,
        [scope.clinicId, sessionId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        state: row.state,
        registrationOrder: Number(row.registration_order),
        publicDisplayLabel: row.public_display_label,
        privateDisplayName: row.private_display_name,
        preferredLocale: row.preferred_locale,
        hasContact: row.contact_phone !== null || row.contact_email !== null,
      }));
    });
  }

  async listOperational(
    scope: ClinicScope,
    sessionId: string,
  ): Promise<{ entries: StaffQueueEntry[]; queueOrderVersion: number }> {
    return inTransaction(this.pool, async (client) => {
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);
      const session = await client.query<{ queue_order_version: string }>(
        `SELECT queue_order_version FROM consultation_sessions
          WHERE id = $1 AND clinic_id = $2 FOR SHARE`,
        [sessionId, scope.clinicId],
      );
      if (session.rowCount !== 1)
        throw new QueueConflictError(
          'Consultation session was not found in this clinic',
        );
      const result = await client.query<{
        id: string;
        session_id: string;
        state: QueueEntryState;
        registration_order: string;
        eligibility_order: string | null;
        priority_order: string | null;
        service_order: string | null;
        public_display_label: string;
        private_display_name: string;
        preferred_locale: 'ar' | 'fr';
        contact_phone: string | null;
        contact_email: string | null;
      }>(
        `SELECT entry.id, entry.session_id, entry.state,
                entry.registration_order, entry.eligibility_order,
                entry.priority_order, entry.service_order, entry.public_display_label,
                patient.private_display_name, patient.preferred_locale,
                patient.contact_phone, patient.contact_email
           FROM queue_entries entry
           JOIN patient_operational_records patient
             ON patient.id = entry.patient_id AND patient.clinic_id = entry.clinic_id
          WHERE entry.clinic_id = $1 AND entry.session_id = $2
          ORDER BY CASE entry.state
                     WHEN 'called' THEN 0 WHEN 'in_consultation' THEN 0
                     WHEN 'checked_in' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
                   entry.service_order NULLS LAST, entry.registration_order`,
        [scope.clinicId, sessionId],
      );
      return {
        queueOrderVersion: Number(session.rows[0]!.queue_order_version),
        entries: result.rows.map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          state: row.state,
          registrationOrder: Number(row.registration_order),
          eligibilityOrder:
            row.eligibility_order === null
              ? null
              : Number(row.eligibility_order),
          priorityOrder:
            row.priority_order === null ? null : Number(row.priority_order),
          serviceOrder:
            row.service_order === null ? null : Number(row.service_order),
          publicDisplayLabel: row.public_display_label,
          privateDisplayName: row.private_display_name,
          preferredLocale: row.preferred_locale,
          hasContact: row.contact_phone !== null || row.contact_email !== null,
        })),
      };
    });
  }

  async command(
    scope: ClinicScope,
    sessionId: string,
    entryId: string,
    rawInput: QueueCommandInput,
  ): Promise<StaffQueueEntry> {
    const reason = rawInput.reason?.trim() || null;
    if (!rawInput.idempotencyKey || rawInput.idempotencyKey.length > 128)
      throw new QueueValidationError('A valid idempotency key is required');
    if (
      (rawInput.command === 'no_show' || rawInput.command === 'cancel') &&
      !reason
    )
      throw new QueueValidationError(
        `${rawInput.command === 'cancel' ? 'Cancellation' : 'No-show'} reason is required`,
      );
    if (rawInput.command === 'cancel' && !rawInput.cancellationSource)
      throw new QueueValidationError('Cancellation source is required');

    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          sessionId,
          entryId,
          command: rawInput.command,
          reason,
          cancellationSource: rawInput.cancellationSource ?? null,
        }),
      )
      .digest('hex');

    return inTransaction(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          `queue-command:${scope.clinicId}:${scope.actorUserId}:${rawInput.idempotencyKey}`,
        ],
      );
      // Retries are re-authorized; a revoked receptionist cannot use a receipt.
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);
      const receipt = await client.query<{
        request_fingerprint: string;
        response: StaffQueueEntry;
      }>(
        `SELECT request_fingerprint, response FROM queue_command_receipts
          WHERE clinic_id=$1 AND actor_user_id=$2 AND idempotency_key=$3`,
        [scope.clinicId, scope.actorUserId, rawInput.idempotencyKey],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].request_fingerprint !== requestFingerprint)
          throw new QueueConflictError(
            'Idempotency key was already used for a different queue command',
          );
        return receipt.rows[0].response;
      }

      const session = await client.query<{ status: string }>(
        `SELECT status FROM consultation_sessions
          WHERE id=$1 AND clinic_id=$2 FOR UPDATE`,
        [sessionId, scope.clinicId],
      );
      if (!session.rows[0])
        throw new QueueConflictError(
          'Consultation session was not found in this clinic',
        );
      if (!['open', 'paused'].includes(session.rows[0].status))
        throw new QueueConflictError(
          'Queue lifecycle commands require an open or paused session',
        );

      const current = await client.query<{
        state: QueueEntryState;
      }>(
        `SELECT state FROM queue_entries
          WHERE id=$1 AND session_id=$2 AND clinic_id=$3 FOR UPDATE`,
        [entryId, sessionId, scope.clinicId],
      );
      const prior = current.rows[0]?.state;
      if (!prior)
        throw new QueueConflictError(
          'Queue entry was not found in this clinic and session',
        );
      const allowed: Record<QueueCommand, readonly QueueEntryState[]> = {
        check_in: ['waiting'],
        call: ['checked_in'],
        no_show: ['checked_in', 'called'],
        cancel: ['waiting', 'checked_in', 'called'],
        start_consultation: ['called'],
        complete_consultation: ['in_consultation'],
      };
      if (!allowed[rawInput.command].includes(prior))
        throw new QueueConflictError(
          `Cannot apply ${rawInput.command} to queue entry in ${prior}`,
        );
      if (rawInput.command === 'call') {
        const next = await client.query<{ id: string }>(
          `SELECT id FROM queue_entries
            WHERE session_id=$1 AND clinic_id=$2 AND state='checked_in'
            ORDER BY service_order NULLS LAST, eligibility_order, registration_order
            LIMIT 1`,
          [sessionId, scope.clinicId],
        );
        if (next.rows[0]?.id !== entryId)
          throw new QueueConflictError(
            'This entry is not next in the committed service order',
          );
      }
      const target: Record<QueueCommand, QueueEntryState> = {
        check_in: 'checked_in',
        call: 'called',
        no_show: 'no_show',
        cancel: 'cancelled',
        start_consultation: 'in_consultation',
        complete_consultation: 'completed',
      };
      let eligibilityOrder: number | null = null;
      if (rawInput.command === 'check_in') {
        const next = await client.query<{ value: string }>(
          `SELECT COALESCE(MAX(eligibility_order), 0) + 1 AS value
             FROM queue_entries WHERE session_id=$1`,
          [sessionId],
        );
        eligibilityOrder = Number(next.rows[0]!.value);
      }
      let serviceOrder: number | null = null;
      if (rawInput.command === 'check_in') {
        const next = await client.query<{ value: string }>(
          `SELECT COALESCE(MAX(service_order), 0) + 1 AS value
             FROM queue_entries WHERE session_id=$1 AND state='checked_in'`,
          [sessionId],
        );
        serviceOrder = Number(next.rows[0]!.value);
      }
      let updated;
      try {
        updated = await client.query<{
          id: string;
          session_id: string;
          state: QueueEntryState;
          registration_order: string;
          eligibility_order: string | null;
          priority_order: string | null;
          service_order: string | null;
          public_display_label: string;
          private_display_name: string;
          preferred_locale: 'ar' | 'fr';
          contact_phone: string | null;
          contact_email: string | null;
        }>(
          `UPDATE queue_entries entry SET state=$4::queue_entry_status,
             eligibility_order=CASE WHEN $4::queue_entry_status='checked_in' THEN $5 ELSE eligibility_order END,
             service_order=CASE WHEN $4::queue_entry_status='checked_in' THEN $6::bigint ELSE NULL END,
             updated_at=now()
           FROM patient_operational_records patient
           WHERE entry.id=$1 AND entry.session_id=$2 AND entry.clinic_id=$3
             AND patient.id=entry.patient_id AND patient.clinic_id=entry.clinic_id
           RETURNING entry.id, entry.session_id, entry.state,
             entry.registration_order, entry.eligibility_order, entry.priority_order, entry.service_order,
             entry.public_display_label, patient.private_display_name,
             patient.preferred_locale, patient.contact_phone, patient.contact_email`,
          [
            entryId,
            sessionId,
            scope.clinicId,
            target[rawInput.command],
            eligibilityOrder,
            serviceOrder,
          ],
        );
      } catch (error) {
        if (
          typeof error === 'object' &&
          error &&
          'code' in error &&
          error.code === '23505'
        )
          throw new QueueConflictError(
            rawInput.command === 'call'
              ? 'Another patient is already called'
              : 'Another consultation is already active',
          );
        throw error;
      }
      const row = updated.rows[0]!;
      const response: StaffQueueEntry = {
        id: row.id,
        sessionId: row.session_id,
        state: row.state,
        registrationOrder: Number(row.registration_order),
        eligibilityOrder:
          row.eligibility_order === null ? null : Number(row.eligibility_order),
        priorityOrder:
          row.priority_order === null ? null : Number(row.priority_order),
        serviceOrder:
          row.service_order === null ? null : Number(row.service_order),
        publicDisplayLabel: row.public_display_label,
        privateDisplayName: row.private_display_name,
        preferredLocale: row.preferred_locale,
        hasContact: row.contact_phone !== null || row.contact_email !== null,
      };
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'queue_entry',
        entityId: entryId,
        action: `queue_entry.${rawInput.command}`,
        metadata: {
          command: rawInput.command,
          outcome: 'applied',
          sessionId,
          from: prior,
          to: response.state,
          reason,
          cancellationSource: rawInput.cancellationSource ?? null,
          correlationId: rawInput.correlationId,
          idempotencyKey: rawInput.idempotencyKey,
        },
      });
      await client.query(
        `INSERT INTO queue_command_receipts
          (clinic_id,actor_user_id,idempotency_key,request_fingerprint,queue_entry_id,response)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          scope.clinicId,
          scope.actorUserId,
          rawInput.idempotencyKey,
          requestFingerprint,
          entryId,
          JSON.stringify(response),
        ],
      );
      return response;
    });
  }

  async reorder(
    scope: ClinicScope,
    sessionId: string,
    entryId: string,
    rawInput: QueueReorderInput,
  ): Promise<QueueReorderResult> {
    const reason = rawInput.reason.trim();
    if (!reason || reason.length > 500)
      throw new QueueValidationError(
        'An operational reason between 1 and 500 characters is required',
      );
    if (
      !Number.isSafeInteger(rawInput.targetPosition) ||
      rawInput.targetPosition < 1
    )
      throw new QueueValidationError(
        'Target position must be a positive integer',
      );
    if (
      !Number.isSafeInteger(rawInput.expectedVersion) ||
      rawInput.expectedVersion < 0
    )
      throw new QueueValidationError(
        'Expected queue version must be a non-negative integer',
      );
    if (!rawInput.idempotencyKey || rawInput.idempotencyKey.length > 128)
      throw new QueueValidationError('A valid idempotency key is required');

    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          sessionId,
          entryId,
          targetPosition: rawInput.targetPosition,
          expectedVersion: rawInput.expectedVersion,
          reason,
        }),
      )
      .digest('hex');

    return inTransaction(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          `queue-reorder:${scope.clinicId}:${scope.actorUserId}:${rawInput.idempotencyKey}`,
        ],
      );
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);
      const receipt = await client.query<{
        request_fingerprint: string;
        response: QueueReorderResult;
      }>(
        `SELECT request_fingerprint,response FROM queue_reorder_receipts
          WHERE clinic_id=$1 AND actor_user_id=$2 AND idempotency_key=$3`,
        [scope.clinicId, scope.actorUserId, rawInput.idempotencyKey],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].request_fingerprint !== requestFingerprint)
          throw new QueueConflictError(
            'Idempotency key was already used for a different reorder command',
          );
        return receipt.rows[0].response;
      }

      const session = await client.query<{
        status: string;
        queue_order_version: string;
      }>(
        `SELECT status,queue_order_version FROM consultation_sessions
          WHERE id=$1 AND clinic_id=$2 FOR UPDATE`,
        [sessionId, scope.clinicId],
      );
      const currentVersion = Number(session.rows[0]?.queue_order_version);
      if (!session.rows[0])
        throw new QueueConflictError(
          'Consultation session was not found in this clinic',
        );
      if (!['open', 'paused'].includes(session.rows[0].status))
        throw new QueueConflictError(
          'Queue reorder requires an open or paused session',
        );
      if (currentVersion !== rawInput.expectedVersion)
        throw new QueueConflictError(
          `Stale queue order version; current version is ${currentVersion}`,
        );

      const ordered = await client.query<{
        id: string;
        registration_order: string;
        eligibility_order: string;
        service_order: string | null;
      }>(
        `SELECT id,registration_order,eligibility_order,service_order
           FROM queue_entries
          WHERE session_id=$1 AND clinic_id=$2 AND state='checked_in'
          ORDER BY service_order NULLS LAST, eligibility_order, registration_order
          FOR UPDATE`,
        [sessionId, scope.clinicId],
      );
      const sourceIndex = ordered.rows.findIndex((row) => row.id === entryId);
      if (sourceIndex < 0)
        throw new QueueConflictError(
          'Only checked-in entries are eligible for reorder',
        );
      if (rawInput.targetPosition > ordered.rows.length)
        throw new QueueConflictError(
          `Target position exceeds the ${ordered.rows.length} eligible entries`,
        );

      const previousOrder = ordered.rows.map((row, index) => ({
        entryId: row.id,
        serviceOrder:
          row.service_order === null ? index + 1 : Number(row.service_order),
      }));
      const reordered = [...ordered.rows];
      const [moved] = reordered.splice(sourceIndex, 1);
      reordered.splice(rawInput.targetPosition - 1, 0, moved!);
      // High temporary values avoid transient collisions with the partial
      // unique index; both phases remain invisible until this transaction commits.
      for (let index = 0; index < reordered.length; index++)
        await client.query(
          'UPDATE queue_entries SET service_order=$2 WHERE id=$1',
          [reordered[index]!.id, reordered.length + index + 1],
        );
      for (let index = 0; index < reordered.length; index++)
        await client.query(
          'UPDATE queue_entries SET service_order=$2,updated_at=now() WHERE id=$1',
          [reordered[index]!.id, index + 1],
        );

      const nextVersion = currentVersion + 1;
      await client.query(
        'UPDATE consultation_sessions SET queue_order_version=$2,updated_at=now() WHERE id=$1',
        [sessionId, nextVersion],
      );
      const row = await client.query<{
        id: string;
        session_id: string;
        state: QueueEntryState;
        registration_order: string;
        eligibility_order: string | null;
        priority_order: string | null;
        service_order: string | null;
        public_display_label: string;
        private_display_name: string;
        preferred_locale: 'ar' | 'fr';
        contact_phone: string | null;
        contact_email: string | null;
      }>(
        `SELECT entry.id,entry.session_id,entry.state,entry.registration_order,
                entry.eligibility_order,entry.priority_order,entry.service_order,
                entry.public_display_label,patient.private_display_name,patient.preferred_locale,
                patient.contact_phone,patient.contact_email
           FROM queue_entries entry JOIN patient_operational_records patient
             ON patient.id=entry.patient_id AND patient.clinic_id=entry.clinic_id
          WHERE entry.id=$1 AND entry.session_id=$2 AND entry.clinic_id=$3`,
        [entryId, sessionId, scope.clinicId],
      );
      const movedRow = row.rows[0]!;
      const entry: StaffQueueEntry = {
        id: movedRow.id,
        sessionId: movedRow.session_id,
        state: movedRow.state,
        registrationOrder: Number(movedRow.registration_order),
        eligibilityOrder:
          movedRow.eligibility_order === null
            ? null
            : Number(movedRow.eligibility_order),
        priorityOrder:
          movedRow.priority_order === null
            ? null
            : Number(movedRow.priority_order),
        serviceOrder:
          movedRow.service_order === null
            ? null
            : Number(movedRow.service_order),
        publicDisplayLabel: movedRow.public_display_label,
        privateDisplayName: movedRow.private_display_name,
        preferredLocale: movedRow.preferred_locale,
        hasContact:
          movedRow.contact_phone !== null || movedRow.contact_email !== null,
      };
      const resultingOrder = reordered.map((item, index) => ({
        entryId: item.id,
        serviceOrder: index + 1,
      }));
      const response = {
        entry,
        queueOrderVersion: nextVersion,
        orderedEntryIds: reordered.map((item) => item.id),
      };
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'queue_entry',
        entityId: entryId,
        action: 'queue_entry.reordered',
        metadata: {
          sessionId,
          reason,
          previousOrder,
          resultingOrder,
          previousVersion: currentVersion,
          resultingVersion: nextVersion,
          targetPosition: rawInput.targetPosition,
          correlationId: rawInput.correlationId,
          idempotencyKey: rawInput.idempotencyKey,
        },
      });
      await client.query(
        `INSERT INTO queue_reorder_receipts
          (clinic_id,actor_user_id,idempotency_key,request_fingerprint,session_id,queue_entry_id,response)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          scope.clinicId,
          scope.actorUserId,
          rawInput.idempotencyKey,
          requestFingerprint,
          sessionId,
          entryId,
          JSON.stringify(response),
        ],
      );
      return response;
    });
  }
}

export function publicQueueEntry(entry: StaffWaitingEntry) {
  return {
    state: entry.state,
    publicDisplayLabel: entry.publicDisplayLabel,
  };
}
