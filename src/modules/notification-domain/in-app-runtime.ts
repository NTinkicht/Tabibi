import type { Pool } from 'pg';
import {
  NotificationDispatchService,
  NotificationPreferenceDeliveryContextResolver,
} from '@/modules/notification-domain';
import { NotificationDispatchBatchRunner } from '@/modules/notification-domain/dispatch-batch';
import { QueueInAppNotificationTargetResolver } from '@/modules/notification-domain/queue-in-app-target-resolver';
import { InAppNotificationInboxRepository } from '@/modules/notification-inbox';
import { InAppNotificationProviderAdapter } from '@/modules/notification-inbox/provider-adapter';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';
import { NotificationDispatchEligibilityRepository } from '@/modules/notification-outbox/dispatch-eligibility';
import { NotificationPreferenceRepository } from '@/modules/notification-preferences';

/**
 * Production composition boundary for zero-network queue-backed in-app delivery.
 *
 * This deliberately wires only existing hardened components:
 * outbox claim/fencing -> server-side queue target -> current preference/consent ->
 * deterministic renderer -> in-app adapter -> durable exact-subject inbox.
 *
 * Triggering/scheduling is intentionally outside this boundary. A caller supplies
 * only the clinic id and notification intent id accepted by NotificationDispatchService;
 * patient/account/subject identity is always derived server-side from the queue entry.
 */
export function createQueueInAppNotificationDispatchService(
  pool: Pool,
): NotificationDispatchService {
  const outbox = new NotificationOutboxRepository(pool);
  const targetResolver = new QueueInAppNotificationTargetResolver(pool);
  const preferences = new NotificationPreferenceRepository(pool);
  const deliveryContext = new NotificationPreferenceDeliveryContextResolver(
    targetResolver,
    preferences,
  );
  const inbox = new InAppNotificationInboxRepository(pool);
  const provider = new InAppNotificationProviderAdapter(inbox);

  return new NotificationDispatchService(outbox, provider, deliveryContext);
}

/**
 * Production composition for one bounded clinic-scoped in-app dispatch batch.
 * Eligibility discovery remains read-only; every selected intent still crosses the
 * existing single-intent claim/fencing, consent, render and provider boundaries.
 */
export function createQueueInAppNotificationDispatchBatchRunner(
  pool: Pool,
): NotificationDispatchBatchRunner {
  const eligibility = new NotificationDispatchEligibilityRepository(pool);
  const dispatch = createQueueInAppNotificationDispatchService(pool);

  return new NotificationDispatchBatchRunner(eligibility, dispatch);
}
