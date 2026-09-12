import type { NotificationDispatchExecution } from '@/modules/notification-domain';
import type { NotificationDispatchEligibleIntent } from '@/modules/notification-outbox/dispatch-eligibility';
import {
  noNotificationDispatchObserver,
  type NotificationDispatchObserver,
} from '@/modules/notification-domain/observability';

export interface NotificationDispatchEligibilityStore {
  listEligible(input: {
    clinicId: string;
    limit: number;
  }): Promise<NotificationDispatchEligibleIntent[]>;
}

export interface NotificationDispatchExecutor {
  dispatchOne(input: {
    clinicId: string;
    intentId: string;
  }): Promise<NotificationDispatchExecution>;
}

export interface NotificationDispatchBatchSummary {
  selected: number;
  completed: number;
  notClaimed: number;
  claimLost: number;
}

/** Runs one bounded, clinic-scoped dispatch batch through the existing claim fence. */
export class NotificationDispatchBatchRunner {
  constructor(
    private readonly eligibilityStore: NotificationDispatchEligibilityStore,
    private readonly executor: NotificationDispatchExecutor,
    private readonly observer: NotificationDispatchObserver = noNotificationDispatchObserver,
  ) {}

  async run(input: {
    clinicId: string;
    limit: number;
  }): Promise<NotificationDispatchBatchSummary> {
    const clinicId = input.clinicId.trim();
    if (!clinicId) throw new Error('Clinic id is required');

    const eligible = await this.eligibilityStore.listEligible({
      clinicId,
      limit: input.limit,
    });
    const summary: NotificationDispatchBatchSummary = {
      selected: eligible.length,
      completed: 0,
      notClaimed: 0,
      claimLost: 0,
    };

    for (const candidate of eligible) {
      const result = await this.executor.dispatchOne({
        clinicId,
        intentId: candidate.intentId,
      });
      if (result.status === 'completed') summary.completed += 1;
      else if (result.status === 'not_claimed') summary.notClaimed += 1;
      else summary.claimLost += 1;
    }

    this.observer.record({
      name: 'notification.dispatch.batch',
      clinicId,
      ...summary,
    });

    return summary;
  }
}
