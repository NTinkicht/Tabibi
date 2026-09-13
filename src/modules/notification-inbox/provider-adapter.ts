import type {
  NotificationProviderAdapter,
  NotificationProviderDispatchContext,
  NotificationProviderResult,
} from '@/modules/notification-domain';
import type { RenderedNotificationDispatchEnvelope } from '@/modules/notification-domain/rendered-dispatch-envelope';
import {
  InAppNotificationInboxConflictError,
  InAppNotificationInboxValidationError,
  type InAppNotificationInboxStore,
} from '@/modules/notification-inbox';

/**
 * Zero-network provider adapter for already-authorized in-app delivery.
 *
 * Routing identity is supplied per dispatch from the freshly resolved delivery
 * context. It is never copied into the rendered provider envelope, preserving
 * WU30's identity-minimal external-provider boundary while preventing adapter
 * reuse from misattributing one subject's message to another subject.
 */
export class InAppNotificationProviderAdapter
  implements NotificationProviderAdapter
{
  constructor(private readonly inbox: InAppNotificationInboxStore) {}

  async dispatch(
    request: RenderedNotificationDispatchEnvelope,
    context: NotificationProviderDispatchContext,
  ): Promise<NotificationProviderResult> {
    if (
      request.channel !== 'in_app' ||
      context.deliveryContext.target.channel !== 'in_app'
    )
      return {
        kind: 'terminal_failure',
        code: 'in_app_channel_mismatch',
      };

    const clinicId = context.clinicId.trim();
    const subjectId = context.deliveryContext.target.subjectId.trim();
    const subjectKind = context.deliveryContext.target.subjectKind;
    if (
      !clinicId ||
      !subjectId ||
      !['visit_patient', 'account'].includes(subjectKind)
    )
      return {
        kind: 'terminal_failure',
        code: 'in_app_delivery_context_mismatch',
      };

    try {
      await this.inbox.persist({
        clinicId,
        subjectKind,
        subjectId,
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
