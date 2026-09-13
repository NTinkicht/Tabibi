import type {
  NotificationProviderAdapter,
  NotificationProviderResult,
} from '@/modules/notification-domain';
import type { RenderedNotificationDispatchEnvelope } from '@/modules/notification-domain/rendered-dispatch-envelope';
import type { NotificationPreferenceSubjectKind } from '@/modules/notification-preferences';
import {
  InAppNotificationInboxConflictError,
  InAppNotificationInboxValidationError,
  type InAppNotificationInboxStore,
} from '@/modules/notification-inbox';

export interface InAppNotificationRoutingScope {
  clinicId: string;
  subjectKind: NotificationPreferenceSubjectKind;
  subjectId: string;
}

/**
 * Zero-network provider adapter for one exact, already-authorized in-app subject.
 *
 * The scope is intentionally bound at composition time instead of being added to
 * the rendered provider envelope. This preserves WU30's external-provider privacy
 * boundary: the envelope still contains no clinic/patient/account identity.
 */
export class InAppNotificationProviderAdapter
  implements NotificationProviderAdapter
{
  private readonly scope: InAppNotificationRoutingScope;

  constructor(
    private readonly inbox: InAppNotificationInboxStore,
    scope: InAppNotificationRoutingScope,
  ) {
    const clinicId = scope.clinicId.trim();
    const subjectId = scope.subjectId.trim();
    if (!clinicId || !subjectId)
      throw new Error('In-app notification routing scope is required');
    if (!['visit_patient', 'account'].includes(scope.subjectKind))
      throw new Error('In-app notification subject kind is not supported');

    this.scope = {
      clinicId,
      subjectKind: scope.subjectKind,
      subjectId,
    };
  }

  async dispatch(
    request: RenderedNotificationDispatchEnvelope,
  ): Promise<NotificationProviderResult> {
    if (request.channel !== 'in_app')
      return {
        kind: 'terminal_failure',
        code: 'in_app_channel_mismatch',
      };

    try {
      await this.inbox.persist({
        ...this.scope,
        envelope: request,
      });
      return { kind: 'delivered', code: 'in_app_persisted' };
    } catch (error) {
      if (
        error instanceof InAppNotificationInboxValidationError ||
        error instanceof InAppNotificationInboxConflictError
      )
        return {
          kind: 'terminal_failure',
          code: 'in_app_persist_rejected',
        };

      return { kind: 'unknown', code: 'in_app_persist_exception' };
    }
  }
}
