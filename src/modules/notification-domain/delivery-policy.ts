import type { NotificationIntent } from '@/modules/notification-outbox';
import {
  isNotificationDeliveryEligible,
  type NotificationChannel,
  type NotificationPreference,
  type NotificationPreferenceSubjectKind,
} from '@/modules/notification-preferences';

export interface NotificationDeliveryTarget {
  subjectKind: NotificationPreferenceSubjectKind;
  subjectId: string;
  channel: NotificationChannel;
}

export interface NotificationDeliveryTargetResolver {
  resolveTarget(
    intent: NotificationIntent,
  ): Promise<NotificationDeliveryTarget | null>;
}

export interface NotificationPreferenceReader {
  get(
    clinicId: string,
    subjectKind: NotificationPreferenceSubjectKind,
    subjectId: string,
    channel: NotificationChannel,
  ): Promise<NotificationPreference | null>;
}

export interface NotificationDeliveryContext {
  target: NotificationDeliveryTarget;
  preference: NotificationPreference | null;
}

export interface NotificationDeliveryContextResolver {
  resolve(
    intent: NotificationIntent,
  ): Promise<NotificationDeliveryContext | null>;
}

/**
 * Resolves the delivery target and loads the latest clinic-scoped preference.
 * Target resolution remains provider-neutral and must never return contact values.
 */
export class NotificationPreferenceDeliveryContextResolver
  implements NotificationDeliveryContextResolver
{
  constructor(
    private readonly targetResolver: NotificationDeliveryTargetResolver,
    private readonly preferences: NotificationPreferenceReader,
  ) {}

  async resolve(
    intent: NotificationIntent,
  ): Promise<NotificationDeliveryContext | null> {
    const target = await this.targetResolver.resolveTarget(intent);
    if (!target) return null;

    const subjectId = target.subjectId.trim();
    if (!subjectId) return null;

    const preference = await this.preferences.get(
      intent.clinicId,
      target.subjectKind,
      subjectId,
      target.channel,
    );
    return {
      target: { ...target, subjectId },
      preference,
    };
  }
}

export type NotificationSuppressionReason =
  | 'delivery_context_missing'
  | 'preference_missing'
  | 'preference_mismatch'
  | 'preference_disabled'
  | 'consent_denied'
  | 'consent_revoked'
  | 'consent_not_authorized';

/** Returns null only when the current preference/consent authorizes dispatch. */
export function notificationSuppressionReason(
  intent: NotificationIntent,
  context: NotificationDeliveryContext | null,
): NotificationSuppressionReason | null {
  if (!context) return 'delivery_context_missing';

  const { target, preference } = context;
  if (!preference) return 'preference_missing';
  if (
    preference.clinicId !== intent.clinicId ||
    preference.subjectKind !== target.subjectKind ||
    preference.subjectId !== target.subjectId ||
    preference.channel !== target.channel
  )
    return 'preference_mismatch';
  if (preference.preferenceState !== 'enabled') return 'preference_disabled';
  if (isNotificationDeliveryEligible(target.channel, preference)) return null;
  if (preference.consentState === 'denied') return 'consent_denied';
  if (preference.consentState === 'revoked') return 'consent_revoked';
  return 'consent_not_authorized';
}
