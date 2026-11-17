import type { Pool } from 'pg';
import type { NotificationDispatchService } from '@/modules/notification-domain';
import type { LinkSender } from '@/modules/guest-access/link-intents';
import {
  createQueueNotificationDispatchService,
  loadPushRuntimeDeps,
  type PushRuntimeDeps,
} from './dispatch-runtime';
import { createPushGuestLinkSender } from './push-link-sender';

export interface WorkerChannels {
  dispatchService: NotificationDispatchService;
  /** Absent unless push is configured: link intents then stay pending. */
  linkSender?: LinkSender;
}

/**
 * Channel registry for the notification worker (docs/design/pwa-push.md
 * section 2). In-app is always registered. Push is registered only when
 * `loadPushRuntimeDeps` finds both the VAPID keys and the seal secret;
 * without them the worker behaves exactly as in-app only.
 */
export function composeWorkerChannels(
  pool: Pool,
  push: PushRuntimeDeps | undefined = loadPushRuntimeDeps(),
): WorkerChannels {
  return {
    dispatchService: createQueueNotificationDispatchService(pool, push),
    linkSender: push ? createPushGuestLinkSender({ pool, ...push }) : undefined,
  };
}
