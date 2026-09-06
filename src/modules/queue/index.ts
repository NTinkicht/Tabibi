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
  const contactEmail =
    normalizeOptional(input.contactEmail)?.toLowerCase() ?? null;
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
}

export function publicQueueEntry(entry: StaffWaitingEntry) {
  return {
    state: entry.state,
    publicDisplayLabel: entry.publicDisplayLabel,
  };
}
