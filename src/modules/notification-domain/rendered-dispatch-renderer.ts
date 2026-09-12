import type { NotificationIntent } from '@/modules/notification-outbox';
import {
  renderNotificationTemplate,
  type RenderNotificationTemplateInput,
} from '@/modules/notification-templates';
import type { NotificationDeliveryContext } from '@/modules/notification-domain/delivery-policy';
import {
  createRenderedNotificationDispatchEnvelope,
  type RenderedNotificationDispatchEnvelope,
} from '@/modules/notification-domain/rendered-dispatch-envelope';

/**
 * Resolves the strict WU28 render input for one already-authorized notification.
 * Implementations may inspect the persisted intent and bounded delivery context,
 * but must not resolve contact destinations, provider credentials, or network data.
 */
export interface NotificationDispatchTemplateInputResolver {
  resolveTemplateInput(input: {
    intent: NotificationIntent;
    deliveryContext: NotificationDeliveryContext;
  }): Promise<RenderNotificationTemplateInput>;
}

export interface NotificationDispatchRenderer {
  renderAuthorized(input: {
    intent: NotificationIntent;
    deliveryContext: NotificationDeliveryContext;
    providerIdempotencyKey: string;
  }): Promise<RenderedNotificationDispatchEnvelope>;
}

function payloadRecord(intent: NotificationIntent): Record<string, unknown> {
  if (
    !intent.payload ||
    typeof intent.payload !== 'object' ||
    Array.isArray(intent.payload)
  )
    throw new Error('Invalid notification render payload');
  return intent.payload;
}

function requiredNumber(
  payload: Record<string, unknown>,
  key: string,
  fallbackKey?: string,
): number {
  const value = payload[key] ?? (fallbackKey ? payload[fallbackKey] : undefined);
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('Missing notification render input');
  return value;
}

/**
 * Converts the persisted outbox event into the already-existing WU28 public render
 * contract. This is event-to-template routing only; copy and validation stay owned
 * by WU28. Unsupported/malformed inputs fail before provider invocation.
 */
export class NotificationIntentTemplateInputResolver
  implements NotificationDispatchTemplateInputResolver
{
  async resolveTemplateInput(input: {
    intent: NotificationIntent;
    deliveryContext: NotificationDeliveryContext;
  }): Promise<RenderNotificationTemplateInput> {
    const payload = payloadRecord(input.intent);
    const locale = typeof payload.locale === 'string' ? payload.locale : null;
    const common = {
      sourceIntentVersion: input.intent.intentVersion,
      locale,
    };

    switch (input.intent.eventKey) {
      case 'appointment_confirmed':
        return {
          ...common,
          templateId: 'appointment_confirmed.v1',
          variables: {},
        };
      case 'queue_entry_created':
        return {
          ...common,
          templateId: 'queue_entry_created.v1',
          variables: {},
        };
      case 'estimate_changed_materially':
        return {
          ...common,
          templateId: 'estimate_changed_materially.v1',
          variables: {
            windowStartMinutes: requiredNumber(payload, 'windowStartMinutes'),
            windowEndMinutes: requiredNumber(payload, 'windowEndMinutes'),
          },
        };
      case 'turn_approaching':
        return {
          ...common,
          templateId: 'turn_approaching.v1',
          variables: {
            position: requiredNumber(payload, 'position', 'places'),
          },
        };
      case 'patient_called':
        return {
          ...common,
          templateId: 'patient_called.v1',
          variables: {},
        };
      case 'session_delayed':
        return {
          ...common,
          templateId: 'session_delayed.v1',
          variables: { delayMinutes: requiredNumber(payload, 'delayMinutes') },
        };
      case 'session_cancelled':
        return {
          ...common,
          templateId: 'session_cancelled.v1',
          variables: {},
        };
      case 'queue_entry_cancelled':
        return {
          ...common,
          templateId: 'queue_entry_cancelled.v1',
          variables: {},
        };
      case 'queue_entry_transferred':
        return {
          ...common,
          templateId: 'queue_entry_transferred.v1',
          variables: {},
        };
      default:
        throw new Error('Unsupported notification render event');
    }
  }
}

/**
 * Composes the existing strict WU28 renderer with the bounded WU30 provider-neutral
 * envelope. This boundary is intentionally invoked only after WU29 authorization.
 */
export class NotificationTemplateDispatchRenderer
  implements NotificationDispatchRenderer
{
  constructor(
    private readonly templateInput: NotificationDispatchTemplateInputResolver,
  ) {}

  async renderAuthorized(input: {
    intent: NotificationIntent;
    deliveryContext: NotificationDeliveryContext;
    providerIdempotencyKey: string;
  }): Promise<RenderedNotificationDispatchEnvelope> {
    const renderInput = await this.templateInput.resolveTemplateInput({
      intent: input.intent,
      deliveryContext: input.deliveryContext,
    });
    const rendered = renderNotificationTemplate(renderInput);
    return createRenderedNotificationDispatchEnvelope({
      channel: input.deliveryContext.target.channel,
      rendered,
      providerIdempotencyKey: input.providerIdempotencyKey,
    });
  }
}

export const defaultNotificationDispatchRenderer: NotificationDispatchRenderer =
  new NotificationTemplateDispatchRenderer(
    new NotificationIntentTemplateInputResolver(),
  );
