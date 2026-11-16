import { guestBearerSigningSecret } from '@/modules/guest-access';
import { GuestLinkEnvelope } from '@/modules/guest-access/link-envelope';
import { sweepExpiredPushBindings } from '@/modules/guest-push/expiry-sweep';
import { GuestLinkIntentStore } from '@/modules/guest-access/link-intents';
import {
  createOutcomeCountingBatchRunner,
  dispatchIntervalMs,
  runDispatchTick,
} from '@/modules/notification-domain/dispatch-worker';
import { createQueueInAppNotificationDispatchService } from '@/modules/notification-domain/in-app';
import { NotificationDispatchEligibilityRepository } from '@/modules/notification-outbox/dispatch-eligibility';
import { closePool, getPool } from '@/platform/database/pool';

/**
 * Scheduler for notification dispatch (TAB-PWA-2). Logs counts only.
 * No link sender is registered yet, so guest-link intents stay pending and
 * expire as before; only in-app delivery and scrubbing run.
 */
async function main(): Promise<void> {
  const intervalMs = dispatchIntervalMs(
    process.env.NOTIFICATION_DISPATCH_INTERVAL_MS,
  );
  const pool = getPool();
  const deps = {
    pool,
    cursor: { after: null as string | null },
    outboxRunner: createOutcomeCountingBatchRunner(
      new NotificationDispatchEligibilityRepository(pool),
      createQueueInAppNotificationDispatchService(pool),
    ),
    linkStore: new GuestLinkIntentStore(
      pool,
      new GuestLinkEnvelope(guestBearerSigningSecret()),
    ),
    pushExpirySweep: () => sweepExpiredPushBindings(pool),
  };

  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = (): void => {
    stopping = true;
    wake?.();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!stopping) {
    try {
      const counts = await runDispatchTick(deps);
      console.log(
        JSON.stringify({ event: 'notification.worker.tick', ...counts }),
      );
    } catch {
      console.error(
        JSON.stringify({ event: 'notification.worker.tick_failed' }),
      );
    }
    if (stopping) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  await closePool();
}

void main().then(
  () => process.exit(0),
  () => {
    console.error(JSON.stringify({ event: 'notification.worker.fatal' }));
    process.exit(1);
  },
);
