import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '@/platform/database/transaction';

export const notificationChannels = [
  'in_app',
  'push',
  'sms',
  'email',
  'whatsapp',
] as const;
export type NotificationChannel = (typeof notificationChannels)[number];
export type NotificationPreferenceSubjectKind = 'visit_patient' | 'account';
export type NotificationPreferenceState = 'enabled' | 'disabled';
export type NotificationConsentState =
  | 'not_required'
  | 'granted'
  | 'denied'
  | 'revoked';

export interface NotificationPreference {
  id: string;
  clinicId: string;
  subjectKind: NotificationPreferenceSubjectKind;
  subjectId: string;
  channel: NotificationChannel;
  preferenceState: NotificationPreferenceState;
  consentState: NotificationConsentState;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChangeNotificationPreferenceInput {
  clinicId: string;
  subjectKind: NotificationPreferenceSubjectKind;
  subjectId: string;
  channel: NotificationChannel;
  preferenceState: NotificationPreferenceState;
  consentState: NotificationConsentState;
  idempotencyKey: string;
  expectedRevision?: number | null;
}

export class NotificationPreferenceValidationError extends Error {}
export class NotificationPreferenceConflictError extends Error {}

interface PreferenceRow {
  id: string;
  clinic_id: string;
  subject_kind: NotificationPreferenceSubjectKind;
  patient_id: string | null;
  account_user_id: string | null;
  channel: NotificationChannel;
  preference_state: NotificationPreferenceState;
  consent_state: NotificationConsentState;
  revision: string;
  created_at: Date;
  updated_at: Date;
}

interface ReceiptRow {
  subject_kind: NotificationPreferenceSubjectKind;
  patient_id: string | null;
  account_user_id: string | null;
  channel: NotificationChannel;
  preference_state: NotificationPreferenceState;
  consent_state: NotificationConsentState;
  expected_revision: string | null;
  preference_id: string;
  result_revision: string;
}

const preferenceColumns = `id, clinic_id, subject_kind, patient_id, account_user_id, channel,
  preference_state, consent_state, revision, created_at, updated_at`;

function toPreference(row: PreferenceRow): NotificationPreference {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    subjectKind: row.subject_kind,
    subjectId: row.patient_id ?? row.account_user_id!,
    channel: row.channel,
    preferenceState: row.preference_state,
    consentState: row.consent_state,
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function normalizeInput(raw: ChangeNotificationPreferenceInput) {
  const clinicId = raw.clinicId.trim();
  const subjectId = raw.subjectId.trim();
  const idempotencyKey = raw.idempotencyKey.trim();
  if (
    !clinicId ||
    !subjectId ||
    !['visit_patient', 'account'].includes(raw.subjectKind)
  )
    throw new NotificationPreferenceValidationError(
      'Clinic id, subject kind and subject id are required',
    );
  if (!notificationChannels.includes(raw.channel))
    throw new NotificationPreferenceValidationError(
      'Notification channel is not supported',
    );
  if (!['enabled', 'disabled'].includes(raw.preferenceState))
    throw new NotificationPreferenceValidationError(
      'Notification preference state is not supported',
    );
  if (
    !['not_required', 'granted', 'denied', 'revoked'].includes(raw.consentState)
  )
    throw new NotificationPreferenceValidationError(
      'Notification consent state is not supported',
    );
  if (!idempotencyKey || idempotencyKey.length > 128)
    throw new NotificationPreferenceValidationError(
      'Idempotency key is required and must be at most 128 characters',
    );
  const expectedRevision = raw.expectedRevision ?? null;
  if (
    expectedRevision !== null &&
    (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0)
  )
    throw new NotificationPreferenceValidationError(
      'Expected revision must be a positive safe integer',
    );
  if (raw.channel === 'in_app' && raw.consentState !== 'not_required')
    throw new NotificationPreferenceValidationError(
      'In-app notifications do not accept a consent state',
    );
  if (raw.channel !== 'in_app' && raw.consentState === 'not_required')
    throw new NotificationPreferenceValidationError(
      'External channels require an explicit consent state',
    );
  return { ...raw, clinicId, subjectId, idempotencyKey, expectedRevision };
}

function assertTransition(
  previous: NotificationConsentState | null,
  next: NotificationConsentState,
): void {
  if (previous === null || previous === next || next === 'granted') return;
  if (previous === 'granted' && next === 'revoked') return;
  throw new NotificationPreferenceValidationError(
    `Invalid notification consent transition from ${previous} to ${next}`,
  );
}

function sameRequest(
  receipt: ReceiptRow,
  input: ReturnType<typeof normalizeInput>,
): boolean {
  return (
    receipt.subject_kind === input.subjectKind &&
    (receipt.patient_id ?? receipt.account_user_id) === input.subjectId &&
    receipt.channel === input.channel &&
    receipt.preference_state === input.preferenceState &&
    receipt.consent_state === input.consentState &&
    (receipt.expected_revision === null
      ? input.expectedRevision === null
      : Number(receipt.expected_revision) === input.expectedRevision)
  );
}

/** Pure, fail-closed policy check for downstream channel adapters. */
export function isNotificationDeliveryEligible(
  channel: NotificationChannel,
  preference: NotificationPreference | null,
): boolean {
  if (!notificationChannels.includes(channel)) return false;
  if (
    !preference ||
    preference.channel !== channel ||
    preference.preferenceState !== 'enabled'
  )
    return false;
  return channel === 'in_app'
    ? preference.consentState === 'not_required'
    : preference.consentState === 'granted';
}

async function loadPreferenceById(
  client: PoolClient,
  clinicId: string,
  id: string,
): Promise<NotificationPreference> {
  const result = await client.query<PreferenceRow>(
    `SELECT ${preferenceColumns} FROM notification_preferences
      WHERE clinic_id=$1 AND id=$2`,
    [clinicId, id],
  );
  const row = result.rows[0];
  if (!row)
    throw new NotificationPreferenceConflictError(
      'Recorded notification preference no longer exists',
    );
  return toPreference(row);
}

/** Clinic-scoped preference store keyed by a visit patient or account identity. */
export class NotificationPreferenceRepository {
  constructor(private readonly pool: Pool) {}

  async get(
    clinicId: string,
    subjectKind: NotificationPreferenceSubjectKind,
    subjectId: string,
    channel: NotificationChannel,
  ): Promise<NotificationPreference | null> {
    const normalized = normalizeInput({
      clinicId,
      subjectKind,
      subjectId,
      channel,
      preferenceState: 'disabled',
      consentState: channel === 'in_app' ? 'not_required' : 'denied',
      idempotencyKey: 'read-validation',
    });
    const result = await this.pool.query<PreferenceRow>(
      `SELECT ${preferenceColumns} FROM notification_preferences
        WHERE clinic_id=$1 AND subject_kind=$2 AND COALESCE(patient_id, account_user_id)=$3 AND channel=$4`,
      [
        normalized.clinicId,
        normalized.subjectKind,
        normalized.subjectId,
        normalized.channel,
      ],
    );
    return result.rows[0] ? toPreference(result.rows[0]) : null;
  }

  async change(
    raw: ChangeNotificationPreferenceInput,
  ): Promise<NotificationPreference> {
    const input = normalizeInput(raw);
    return inTransaction(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          `notification-preference:${input.clinicId}:${input.subjectKind}:${input.subjectId}:${input.channel}`,
        ],
      );
      const priorReceipt = await client.query<ReceiptRow>(
        `SELECT subject_kind, patient_id, account_user_id, channel, preference_state, consent_state,
                expected_revision, preference_id, result_revision
           FROM notification_preference_receipts
          WHERE clinic_id=$1 AND idempotency_key=$2`,
        [input.clinicId, input.idempotencyKey],
      );
      const receipt = priorReceipt.rows[0];
      if (receipt) {
        if (!sameRequest(receipt, input))
          throw new NotificationPreferenceConflictError(
            'Idempotency key was already used for a different preference change',
          );
        return loadPreferenceById(
          client,
          input.clinicId,
          receipt.preference_id,
        );
      }

      const currentResult = await client.query<PreferenceRow>(
        `SELECT ${preferenceColumns} FROM notification_preferences
          WHERE clinic_id=$1 AND subject_kind=$2 AND COALESCE(patient_id, account_user_id)=$3 AND channel=$4 FOR UPDATE`,
        [input.clinicId, input.subjectKind, input.subjectId, input.channel],
      );
      const current = currentResult.rows[0] ?? null;
      if (
        input.expectedRevision !== null &&
        Number(current?.revision ?? 0) !== input.expectedRevision
      )
        throw new NotificationPreferenceConflictError(
          'Notification preference revision does not match',
        );
      assertTransition(current?.consent_state ?? null, input.consentState);

      let persisted: PreferenceRow;
      if (current) {
        if (
          current.preference_state === input.preferenceState &&
          current.consent_state === input.consentState
        ) {
          persisted = current;
        } else {
          if (input.expectedRevision === null)
            throw new NotificationPreferenceConflictError(
              'Expected revision is required to change an existing notification preference',
            );
          const updated = await client.query<PreferenceRow>(
            `UPDATE notification_preferences
                SET preference_state=$5, consent_state=$6,
                    revision=revision + 1, updated_at=now()
              WHERE clinic_id=$1 AND subject_kind=$2 AND COALESCE(patient_id, account_user_id)=$3 AND channel=$4
              RETURNING ${preferenceColumns}`,
            [
              input.clinicId,
              input.subjectKind,
              input.subjectId,
              input.channel,
              input.preferenceState,
              input.consentState,
            ],
          );
          persisted = updated.rows[0]!;
        }
      } else {
        const inserted = await client.query<PreferenceRow>(
          `INSERT INTO notification_preferences
             (id, clinic_id, subject_kind, patient_id, account_user_id, channel, preference_state, consent_state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING ${preferenceColumns}`,
          [
            randomUUID(),
            input.clinicId,
            input.subjectKind,
            input.subjectKind === 'visit_patient' ? input.subjectId : null,
            input.subjectKind === 'account' ? input.subjectId : null,
            input.channel,
            input.preferenceState,
            input.consentState,
          ],
        );
        persisted = inserted.rows[0]!;
      }
      await client.query(
        `INSERT INTO notification_preference_receipts
           (clinic_id, idempotency_key, subject_kind, patient_id, account_user_id, channel,
            preference_state, consent_state, expected_revision,
            preference_id, result_revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          input.clinicId,
          input.idempotencyKey,
          input.subjectKind,
          input.subjectKind === 'visit_patient' ? input.subjectId : null,
          input.subjectKind === 'account' ? input.subjectId : null,
          input.channel,
          input.preferenceState,
          input.consentState,
          input.expectedRevision,
          persisted.id,
          Number(persisted.revision),
        ],
      );
      return toPreference(persisted);
    });
  }
}
