import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { RenderedNotificationDispatchEnvelope } from '@/modules/notification-domain/rendered-dispatch-envelope';
import type { NotificationPreferenceSubjectKind } from '@/modules/notification-preferences';
import type {
  NotificationTemplateDirection,
  NotificationTemplateId,
  NotificationTemplateLocale,
} from '@/modules/notification-templates';

export interface InAppNotificationInboxItem {
  id: string;
  clinicId: string;
  subjectKind: NotificationPreferenceSubjectKind;
  subjectId: string;
  providerIdempotencyKey: string;
  templateId: NotificationTemplateId;
  locale: NotificationTemplateLocale;
  direction: NotificationTemplateDirection;
  title: string;
  body: string;
  createdAt: string;
}

export interface PersistInAppNotificationInput {
  clinicId: string;
  subjectKind: NotificationPreferenceSubjectKind;
  subjectId: string;
  envelope: RenderedNotificationDispatchEnvelope;
}

export interface InAppNotificationInboxStore {
  persist(
    input: PersistInAppNotificationInput,
  ): Promise<InAppNotificationInboxItem>;

  listForSubject(input: {
    clinicId: string;
    subjectKind: NotificationPreferenceSubjectKind;
    subjectId: string;
    limit: number;
  }): Promise<InAppNotificationInboxItem[]>;
}

export class InAppNotificationInboxValidationError extends Error {}
export class InAppNotificationInboxConflictError extends Error {}

interface InboxRow {
  id: string;
  clinic_id: string;
  subject_kind: NotificationPreferenceSubjectKind;
  patient_id: string | null;
  account_user_id: string | null;
  provider_idempotency_key: string;
  template_id: NotificationTemplateId;
  locale: NotificationTemplateLocale;
  direction: NotificationTemplateDirection;
  title: string;
  body: string;
  created_at: Date;
}

const inboxColumns = `id, clinic_id, subject_kind, patient_id, account_user_id,
  provider_idempotency_key, template_id, locale, direction, title, body, created_at`;

function toInboxItem(row: InboxRow): InAppNotificationInboxItem {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    subjectKind: row.subject_kind,
    subjectId: row.patient_id ?? row.account_user_id!,
    providerIdempotencyKey: row.provider_idempotency_key,
    templateId: row.template_id,
    locale: row.locale,
    direction: row.direction,
    title: row.title,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Validates the privacy-minimal routing metadata required to persist an already
 * authorized/rendered in-app notification. Contact values, credentials, raw
 * intent payloads and arbitrary template variables are deliberately absent.
 */
export function validateInAppNotificationWrite(
  raw: PersistInAppNotificationInput,
): PersistInAppNotificationInput {
  const clinicId = raw.clinicId.trim();
  const subjectId = raw.subjectId.trim();
  if (!clinicId || !subjectId)
    throw new InAppNotificationInboxValidationError(
      'Clinic id and subject id are required',
    );
  if (!['visit_patient', 'account'].includes(raw.subjectKind))
    throw new InAppNotificationInboxValidationError(
      'Notification subject kind is not supported',
    );
  if (raw.envelope.channel !== 'in_app')
    throw new InAppNotificationInboxValidationError(
      'In-app inbox accepts only in_app dispatch envelopes',
    );

  const providerIdempotencyKey = raw.envelope.providerIdempotencyKey.trim();
  if (!providerIdempotencyKey || providerIdempotencyKey.length > 160)
    throw new InAppNotificationInboxValidationError(
      'Provider idempotency key is required and must be at most 160 characters',
    );
  if (!raw.envelope.title || raw.envelope.title.length > 512)
    throw new InAppNotificationInboxValidationError(
      'Rendered title must be between 1 and 512 characters',
    );
  if (!raw.envelope.body || raw.envelope.body.length > 8000)
    throw new InAppNotificationInboxValidationError(
      'Rendered body must be between 1 and 8000 characters',
    );

  return {
    clinicId,
    subjectKind: raw.subjectKind,
    subjectId,
    envelope: {
      ...raw.envelope,
      providerIdempotencyKey,
    },
  };
}

function validateReadScope(input: {
  clinicId: string;
  subjectKind: NotificationPreferenceSubjectKind;
  subjectId: string;
  limit: number;
}) {
  const clinicId = input.clinicId.trim();
  const subjectId = input.subjectId.trim();
  if (!clinicId || !subjectId)
    throw new InAppNotificationInboxValidationError(
      'Clinic id and subject id are required',
    );
  if (!['visit_patient', 'account'].includes(input.subjectKind))
    throw new InAppNotificationInboxValidationError(
      'Notification subject kind is not supported',
    );
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new InAppNotificationInboxValidationError(
      'Inbox read limit must be between 1 and 100',
    );
  return { ...input, clinicId, subjectId };
}

function sameLogicalWrite(
  row: InboxRow,
  input: PersistInAppNotificationInput,
): boolean {
  const subjectId = row.patient_id ?? row.account_user_id;
  return (
    row.clinic_id === input.clinicId &&
    row.subject_kind === input.subjectKind &&
    subjectId === input.subjectId &&
    row.provider_idempotency_key === input.envelope.providerIdempotencyKey &&
    row.template_id === input.envelope.templateId &&
    row.locale === input.envelope.locale &&
    row.direction === input.envelope.direction &&
    row.title === input.envelope.title &&
    row.body === input.envelope.body
  );
}

/** PostgreSQL-backed, clinic- and exact-subject-scoped in-app inbox store. */
export class InAppNotificationInboxRepository
  implements InAppNotificationInboxStore
{
  constructor(private readonly pool: Pool) {}

  async persist(
    raw: PersistInAppNotificationInput,
  ): Promise<InAppNotificationInboxItem> {
    const input = validateInAppNotificationWrite(raw);
    const patientId =
      input.subjectKind === 'visit_patient' ? input.subjectId : null;
    const accountUserId =
      input.subjectKind === 'account' ? input.subjectId : null;
    const id = randomUUID();

    const inserted = await this.pool.query<InboxRow>(
      `INSERT INTO notification_inbox_items (
         id, clinic_id, subject_kind, patient_id, account_user_id,
         provider_idempotency_key, template_id, locale, direction, title, body
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (clinic_id, provider_idempotency_key) DO NOTHING
       RETURNING ${inboxColumns}`,
      [
        id,
        input.clinicId,
        input.subjectKind,
        patientId,
        accountUserId,
        input.envelope.providerIdempotencyKey,
        input.envelope.templateId,
        input.envelope.locale,
        input.envelope.direction,
        input.envelope.title,
        input.envelope.body,
      ],
    );
    if (inserted.rows[0]) return toInboxItem(inserted.rows[0]);

    const existing = await this.pool.query<InboxRow>(
      `SELECT ${inboxColumns}
         FROM notification_inbox_items
        WHERE clinic_id=$1 AND provider_idempotency_key=$2`,
      [input.clinicId, input.envelope.providerIdempotencyKey],
    );
    const row = existing.rows[0];
    if (!row || !sameLogicalWrite(row, input))
      throw new InAppNotificationInboxConflictError(
        'Provider idempotency key was already used for a different inbox write',
      );
    return toInboxItem(row);
  }

  async listForSubject(raw: {
    clinicId: string;
    subjectKind: NotificationPreferenceSubjectKind;
    subjectId: string;
    limit: number;
  }): Promise<InAppNotificationInboxItem[]> {
    const input = validateReadScope(raw);
    const patientId =
      input.subjectKind === 'visit_patient' ? input.subjectId : null;
    const accountUserId =
      input.subjectKind === 'account' ? input.subjectId : null;
    const result = await this.pool.query<InboxRow>(
      `SELECT ${inboxColumns}
         FROM notification_inbox_items
        WHERE clinic_id=$1
          AND subject_kind=$2
          AND patient_id IS NOT DISTINCT FROM $3::uuid
          AND account_user_id IS NOT DISTINCT FROM $4::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [
        input.clinicId,
        input.subjectKind,
        patientId,
        accountUserId,
        input.limit,
      ],
    );
    return result.rows.map(toInboxItem);
  }
}
