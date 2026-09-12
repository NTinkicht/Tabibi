import type { NotificationDispatchOutcome } from '@/modules/notification-outbox';

export type NotificationDispatchOperationalEvent =
  | {
      name: 'notification.dispatch.not_claimed';
      clinicId: string;
      intentId: string;
    }
  | {
      name: 'notification.dispatch.claim_lost';
      clinicId: string;
      intentId: string;
      providerResultKind:
        | 'delivered'
        | 'retryable_failure'
        | 'unknown'
        | 'terminal_failure';
    }
  | {
      name: 'notification.dispatch.outcome';
      clinicId: string;
      intentId: string;
      outcome: NotificationDispatchOutcome;
      attempt: number;
      maxAttempts: number;
      retryScheduled: boolean;
      exhausted: boolean;
    }
  | {
      name: 'notification.dispatch.batch';
      clinicId: string;
      selected: number;
      completed: number;
      notClaimed: number;
      claimLost: number;
    };

/** Receives metadata-only operational events; it is not an audit-history sink. */
export interface NotificationDispatchObserver {
  record(event: NotificationDispatchOperationalEvent): void;
}

export const noNotificationDispatchObserver: NotificationDispatchObserver = {
  record: () => undefined,
};

const OBSERVER_FAILURE_CATEGORY = 'notification.dispatch.observer_failure';

/** Keeps optional operational telemetry from becoming a dispatch dependency. */
export function recordNotificationDispatchEvent(
  observer: NotificationDispatchObserver,
  event: NotificationDispatchOperationalEvent,
): void {
  try {
    observer.record(event);
  } catch {
    // Deliberately omit the event and exception: both may contain sensitive data.
    console.error(OBSERVER_FAILURE_CATEGORY);
  }
}
