import type { NotificationPreferenceSubjectKind } from '@/modules/notification-preferences';
import type {
  NotificationTemplateDirection,
  NotificationTemplateId,
  NotificationTemplateLocale,
} from '@/modules/notification-templates';
import type { RenderedNotificationDispatchEnvelope } from '@/modules/notification-domain';

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
