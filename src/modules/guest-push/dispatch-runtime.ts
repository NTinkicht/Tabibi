import type { Pool } from 'pg';
import {
  NotificationDispatchService,
  NotificationPreferenceDeliveryContextResolver,
  type NotificationProviderAdapter,
} from '@/modules/notification-domain';
import { NotificationDispatchBatchRunner } from '@/modules/notification-domain/dispatch-batch';
import { QueueInAppNotificationTargetResolver } from '@/modules/notification-domain/queue-in-app-target-resolver';
import { InAppNotificationInboxRepository } from '@/modules/notification-inbox';
import { InAppNotificationProviderAdapter } from '@/modules/notification-inbox/provider-adapter';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';
import { NotificationDispatchEligibilityRepository } from '@/modules/notification-outbox/dispatch-eligibility';
import { NotificationPreferenceRepository } from '@/modules/notification-preferences';
import { optionalPushSealer } from './config';
import { PushNotificationProviderAdapter } from './push-notification-adapter';
import { PushPreferringTargetResolver } from './push-target-resolver';
import { WebPushTransport } from './push-transport';
import type { PushSubscriptionSealer } from './subscription-seal';
import { loadVapidConfig, type VapidConfig } from './vapid-config';

export interface PushRuntimeDeps {
  sealer: PushSubscriptionSealer;
  transport: Pick<WebPushTransport, 'send'>;
}

/**
 * Push is registered only when VAPID keys and the seal secret are both
 * configured (docs/design/pwa-push.md section 4). Otherwise this returns
 * undefined and delivery behaves exactly as in-app only.
 */
export function loadPushRuntimeDeps(
  vapid: VapidConfig | null = loadVapidConfig() ?? null,
  sealer: PushSubscriptionSealer | null = optionalPushSealer() ?? null,
): PushRuntimeDeps | undefined {
  if (!vapid || !sealer) return undefined;
  return { sealer, transport: new WebPushTransport(vapid) };
}

/**
 * Queue notification dispatch for in-app delivery that upgrades an intent to
 * `push` when its queue entry has an active binding. Outbox claim/fencing,
 * the consent gate and the generic renderer are the same hardened components
 * as the in-app path; only the target channel and the adapter differ. With
 * no push deps the composition is identical to the in-app-only one.
 */
export function createQueueNotificationDispatchService(
  pool: Pool,
  push?: PushRuntimeDeps,
): NotificationDispatchService {
  const outbox = new NotificationOutboxRepository(pool);
  const inAppTargets = new QueueInAppNotificationTargetResolver(pool);
  const targets = push
    ? new PushPreferringTargetResolver(pool, inAppTargets)
    : inAppTargets;
  const deliveryContext = new NotificationPreferenceDeliveryContextResolver(
    targets,
    new NotificationPreferenceRepository(pool),
  );
  const inApp = new InAppNotificationProviderAdapter(
    new InAppNotificationInboxRepository(pool),
  );
  const pushAdapter = push
    ? new PushNotificationProviderAdapter({ pool, ...push })
    : undefined;
  const provider: NotificationProviderAdapter = {
    dispatch: (request, context) =>
      request.channel === 'push' && pushAdapter
        ? pushAdapter.dispatch(request, context)
        : inApp.dispatch(request, context),
  };
  return new NotificationDispatchService(outbox, provider, deliveryContext);
}

export function createQueueNotificationDispatchBatchRunner(
  pool: Pool,
  push: PushRuntimeDeps | undefined = loadPushRuntimeDeps(),
): NotificationDispatchBatchRunner {
  return new NotificationDispatchBatchRunner(
    new NotificationDispatchEligibilityRepository(pool),
    createQueueNotificationDispatchService(pool, push),
  );
}
