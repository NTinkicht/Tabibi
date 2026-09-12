import type {
  CompleteNotificationDispatchInput,
  NotificationDispatchClaim,
  NotificationDispatchOutcome,
  NotificationIntent,
} from '@/modules/notification-outbox';
import {
  notificationSuppressionReason,
  type NotificationDeliveryContext,
  type NotificationDeliveryContextResolver,
  type NotificationSuppressionReason,
} from '@/modules/notification-domain/delivery-policy';
import {
  noNotificationDispatchObserver,
  recordNotificationDispatchEvent,
  type NotificationDispatchObserver,
} from '@/modules/notification-domain/observability';
import {
  defaultNotificationDispatchRenderer,
  type NotificationDispatchRenderer,
} from '@/modules/notification-domain/rendered-dispatch-renderer';
import type { RenderedNotificationDispatchEnvelope } from '@/modules/notification-domain/rendered-dispatch-envelope';

export type {
  NotificationDispatchOperationalEvent,
  NotificationDispatchObserver,
} from '@/modules/notification-domain/observability';
export {
  NotificationPreferenceDeliveryContextResolver,
  notificationSuppressionReason,
  type NotificationDeliveryContext,
  type NotificationDeliveryContextResolver,
  type NotificationDeliveryTarget,
  type NotificationDeliveryTargetResolver,
  type NotificationPreferenceReader,
  type NotificationSuppressionReason,
} from '@/modules/notification-domain/delivery-policy';
export {
  createRenderedNotificationDispatchEnvelope,
  type RenderedNotificationDispatchEnvelope,
} from '@/modules/notification-domain/rendered-dispatch-envelope';
export {
  defaultNotificationDispatchRenderer,
  NotificationIntentTemplateInputResolver,
  NotificationTemplateDispatchRenderer,
  type NotificationDispatchRenderer,
  type NotificationDispatchTemplateInputResolver,
} from '@/modules/notification-domain/rendered-dispatch-renderer';

export type NotificationProviderResult =
  | { kind: 'delivered'; code?: string | null }
  | { kind: 'retryable_failure'; code?: string | null }
  | { kind: 'unknown'; code?: string | null }
  | { kind: 'terminal_failure'; code?: string | null };

export type NotificationProviderRequest = RenderedNotificationDispatchEnvelope;

export interface NotificationProviderAdapter {
  dispatch(
    request: NotificationProviderRequest,
  ): Promise<NotificationProviderResult>;
}

export interface NotificationDispatchStore {
  claimPendingIntent(input: {
    clinicId: string;
    intentId: string;
    leaseMs: number;
  }): Promise<NotificationDispatchClaim | null>;
  completeDispatchAttempt(
    input: CompleteNotificationDispatchInput,
  ): Promise<NotificationIntent | null>;
}

export type NotificationDispatchExecution =
  | { status: 'not_claimed' }
  | {
      status: 'claim_lost';
      claimToken: string;
      providerIdempotencyKey?: string;
      providerResult?: NotificationProviderResult;
      suppressionReason?: NotificationSuppressionReason;
    }
  | {
      status: 'suppressed';
      claimToken: string;
      suppressionReason: NotificationSuppressionReason;
      intent: NotificationIntent;
    }
  | {
      status: 'completed';
      claimToken: string;
      providerIdempotencyKey: string;
      providerResult: NotificationProviderResult;
      intent: NotificationIntent;
    };

function normalizeProviderResult(result: unknown): NotificationProviderResult {
  if (!result || typeof result !== 'object')
    return { kind: 'unknown', code: 'provider_indeterminate_result' };

  const candidate = result as { kind?: unknown; code?: unknown };
  const validKind =
    candidate.kind === 'delivered' ||
    candidate.kind === 'retryable_failure' ||
    candidate.kind === 'unknown' ||
    candidate.kind === 'terminal_failure';
  const validCode =
    candidate.code === undefined ||
    candidate.code === null ||
    (typeof candidate.code === 'string' && candidate.code.length <= 160);

  if (!validKind || !validCode)
    return { kind: 'unknown', code: 'provider_indeterminate_result' };

  return {
    kind: candidate.kind,
    ...(candidate.code === undefined ? {} : { code: candidate.code }),
  } as NotificationProviderResult;
}

function toPersistedOutcome(
  result: NotificationProviderResult,
): NotificationDispatchOutcome {
  switch (result.kind) {
    case 'delivered':
      return 'delivered';
    case 'retryable_failure':
      return 'failed';
    case 'unknown':
      return 'unknown';
    case 'terminal_failure':
      return 'dead_letter';
  }
}

function providerIdempotencyKey(claim: NotificationDispatchClaim): string {
  return `notification:${claim.intent.id}`;
}

function recordPersistedOutcome(
  observer: NotificationDispatchObserver,
  completed: NotificationIntent,
): void {
  recordNotificationDispatchEvent(observer, {
    name: 'notification.dispatch.outcome',
    clinicId: completed.clinicId,
    intentId: completed.id,
    outcome: completed.state as NotificationDispatchOutcome,
    attempt: completed.dispatchAttemptCount,
    maxAttempts: completed.dispatchMaxAttempts,
    retryScheduled: completed.nextAttemptAt !== null,
    exhausted:
      completed.state === 'dead_letter' &&
      completed.dispatchAttemptCount >= completed.dispatchMaxAttempts,
  });
}

/** Executes one already-persisted notification intent through an injected provider. */
export class NotificationDispatchService {
  constructor(
    private readonly store: NotificationDispatchStore,
    private readonly provider: NotificationProviderAdapter,
    private readonly deliveryContext: NotificationDeliveryContextResolver,
    private readonly leaseMs = 60_000,
    private readonly observer: NotificationDispatchObserver = noNotificationDispatchObserver,
    private readonly renderer: NotificationDispatchRenderer = defaultNotificationDispatchRenderer,
  ) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 86_400_000)
      throw new Error('Dispatch lease must be between 1 ms and 24 hours');
  }

  async dispatchOne(input: {
    clinicId: string;
    intentId: string;
  }): Promise<NotificationDispatchExecution> {
    const clinicId = input.clinicId.trim();
    const intentId = input.intentId.trim();
    if (!clinicId || !intentId)
      throw new Error('Clinic id and intent id are required');

    const claim = await this.store.claimPendingIntent({
      clinicId,
      intentId,
      leaseMs: this.leaseMs,
    });
    if (!claim) {
      recordNotificationDispatchEvent(this.observer, {
        name: 'notification.dispatch.not_claimed',
        clinicId,
        intentId,
      });
      return { status: 'not_claimed' };
    }

    const idempotencyKey = providerIdempotencyKey(claim);
    let currentDeliveryContext: NotificationDeliveryContext;
    try {
      currentDeliveryContext = await this.deliveryContext.resolve(claim.intent);
    } catch {
      const resolverResult: NotificationProviderResult = {
        kind: 'retryable_failure',
        code: 'delivery_context_failure',
      };
      const completed = await this.store.completeDispatchAttempt({
        clinicId,
        intentId: claim.intent.id,
        claimToken: claim.claimToken,
        outcome: 'failed',
        outcomeCode: 'delivery_context_failure',
      });

      if (!completed) {
        recordNotificationDispatchEvent(this.observer, {
          name: 'notification.dispatch.claim_lost',
          clinicId,
          intentId: claim.intent.id,
          providerResultKind: resolverResult.kind,
        });
        return {
          status: 'claim_lost',
          claimToken: claim.claimToken,
          providerIdempotencyKey: idempotencyKey,
          providerResult: resolverResult,
        };
      }

      recordPersistedOutcome(this.observer, completed);
      return {
        status: 'completed',
        claimToken: claim.claimToken,
        providerIdempotencyKey: idempotencyKey,
        providerResult: resolverResult,
        intent: completed,
      };
    }

    const suppressionReason = notificationSuppressionReason(
      claim.intent,
      currentDeliveryContext,
    );

    if (suppressionReason) {
      const suppressed = await this.store.completeDispatchAttempt({
        clinicId,
        intentId: claim.intent.id,
        claimToken: claim.claimToken,
        outcome: 'suppressed',
        outcomeCode: suppressionReason,
      });

      if (!suppressed) {
        recordNotificationDispatchEvent(this.observer, {
          name: 'notification.dispatch.claim_lost',
          clinicId,
          intentId: claim.intent.id,
          providerResultKind: 'suppressed',
        });
        return {
          status: 'claim_lost',
          claimToken: claim.claimToken,
          suppressionReason,
        };
      }

      recordPersistedOutcome(this.observer, suppressed);
      return {
        status: 'suppressed',
        claimToken: claim.claimToken,
        suppressionReason,
        intent: suppressed,
      };
    }

    let providerRequest: RenderedNotificationDispatchEnvelope;
    try {
      providerRequest = await this.renderer.renderAuthorized({
        intent: claim.intent,
        deliveryContext: currentDeliveryContext,
        providerIdempotencyKey: idempotencyKey,
      });
    } catch {
      const rendererResult: NotificationProviderResult = {
        kind: 'retryable_failure',
        code: 'render_failure',
      };
      const completed = await this.store.completeDispatchAttempt({
        clinicId,
        intentId: claim.intent.id,
        claimToken: claim.claimToken,
        outcome: 'failed',
        outcomeCode: 'render_failure',
      });

      if (!completed) {
        recordNotificationDispatchEvent(this.observer, {
          name: 'notification.dispatch.claim_lost',
          clinicId,
          intentId: claim.intent.id,
          providerResultKind: rendererResult.kind,
        });
        return {
          status: 'claim_lost',
          claimToken: claim.claimToken,
          providerIdempotencyKey: idempotencyKey,
          providerResult: rendererResult,
        };
      }

      recordPersistedOutcome(this.observer, completed);
      return {
        status: 'completed',
        claimToken: claim.claimToken,
        providerIdempotencyKey: idempotencyKey,
        providerResult: rendererResult,
        intent: completed,
      };
    }

    let providerResult: NotificationProviderResult;
    try {
      providerResult = normalizeProviderResult(
        await this.provider.dispatch(providerRequest),
      );
    } catch {
      providerResult = { kind: 'unknown', code: 'provider_exception' };
    }

    const completed = await this.store.completeDispatchAttempt({
      clinicId,
      intentId: claim.intent.id,
      claimToken: claim.claimToken,
      outcome: toPersistedOutcome(providerResult),
      outcomeCode: providerResult.code ?? null,
    });

    if (!completed) {
      recordNotificationDispatchEvent(this.observer, {
        name: 'notification.dispatch.claim_lost',
        clinicId,
        intentId: claim.intent.id,
        providerResultKind: providerResult.kind,
      });
      return {
        status: 'claim_lost',
        claimToken: claim.claimToken,
        providerIdempotencyKey: idempotencyKey,
        providerResult,
      };
    }

    recordPersistedOutcome(this.observer, completed);
    return {
      status: 'completed',
      claimToken: claim.claimToken,
      providerIdempotencyKey: idempotencyKey,
      providerResult,
      intent: completed,
    };
  }
}
