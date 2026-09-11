import type {
  CompleteNotificationDispatchInput,
  NotificationDispatchClaim,
  NotificationDispatchOutcome,
  NotificationIntent,
} from '@/modules/notification-outbox';

export type NotificationProviderResult =
  | { kind: 'delivered'; code?: string | null }
  | { kind: 'retryable_failure'; code?: string | null }
  | { kind: 'unknown'; code?: string | null }
  | { kind: 'terminal_failure'; code?: string | null };

export interface NotificationProviderRequest {
  clinicId: string;
  intentId: string;
  payload: Record<string, unknown>;
  providerIdempotencyKey: string;
}

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
      providerIdempotencyKey: string;
      providerResult: NotificationProviderResult;
    }
  | {
      status: 'completed';
      claimToken: string;
      providerIdempotencyKey: string;
      providerResult: NotificationProviderResult;
      intent: NotificationIntent;
    };

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
  return `notification:${claim.intent.id}:attempt:${claim.intent.dispatchAttemptCount}`;
}

/** Executes one already-persisted notification intent through an injected provider. */
export class NotificationDispatchService {
  constructor(
    private readonly store: NotificationDispatchStore,
    private readonly provider: NotificationProviderAdapter,
    private readonly leaseMs = 60_000,
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
    if (!claim) return { status: 'not_claimed' };

    const idempotencyKey = providerIdempotencyKey(claim);
    let providerResult: NotificationProviderResult;
    try {
      providerResult = await this.provider.dispatch({
        clinicId,
        intentId: claim.intent.id,
        payload: claim.intent.payload,
        providerIdempotencyKey: idempotencyKey,
      });
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

    if (!completed)
      return {
        status: 'claim_lost',
        claimToken: claim.claimToken,
        providerIdempotencyKey: idempotencyKey,
        providerResult,
      };

    return {
      status: 'completed',
      claimToken: claim.claimToken,
      providerIdempotencyKey: idempotencyKey,
      providerResult,
      intent: completed,
    };
  }
}
