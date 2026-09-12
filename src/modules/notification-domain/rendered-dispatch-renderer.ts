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
