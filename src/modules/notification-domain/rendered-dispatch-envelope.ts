import type { NotificationChannel } from '@/modules/notification-preferences';
import type {
  NotificationTemplateDirection,
  NotificationTemplateId,
  NotificationTemplateLocale,
  RenderedNotificationTemplate,
} from '@/modules/notification-templates';

/**
 * Ephemeral provider-neutral content passed only after current delivery
 * authorization succeeds. It deliberately contains no destination/contact value,
 * clinic/patient identity, credential, provider metadata, or template variables.
 */
export interface RenderedNotificationDispatchEnvelope {
  channel: NotificationChannel;
  locale: NotificationTemplateLocale;
  direction: NotificationTemplateDirection;
  templateId: NotificationTemplateId;
  title: string;
  body: string;
  providerIdempotencyKey: string;
}

/**
 * Builds the bounded provider request content from an already-rendered WU28
 * template. Callers remain responsible for enforcing the WU29 consent gate before
 * rendering or constructing this envelope.
 */
export function createRenderedNotificationDispatchEnvelope(input: {
  channel: NotificationChannel;
  rendered: RenderedNotificationTemplate;
  providerIdempotencyKey: string;
}): RenderedNotificationDispatchEnvelope {
  const providerIdempotencyKey = input.providerIdempotencyKey.trim();
  if (!providerIdempotencyKey)
    throw new Error('Provider idempotency key is required');

  return {
    channel: input.channel,
    locale: input.rendered.locale,
    direction: input.rendered.direction,
    templateId: input.rendered.templateId,
    title: input.rendered.title,
    body: input.rendered.body,
    providerIdempotencyKey,
  };
}
