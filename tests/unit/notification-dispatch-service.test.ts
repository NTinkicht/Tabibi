import { describe, expect, it, vi } from 'vitest';
import type {
  CompleteNotificationDispatchInput,
  NotificationDispatchClaim,
  NotificationIntent,
} from '@/modules/notification-outbox';
import {
  NotificationDispatchService,
  type NotificationDispatchStore,
  type NotificationProviderAdapter,
  type NotificationProviderResult,
} from '@/modules/notification-domain';

function intent(
  overrides: Partial<NotificationIntent> = {},
): NotificationIntent {
  return {
    id: 'intent-1',
    clinicId: 'clinic-1',
    queueEntryId: null,
    logicalTargetKey: 'queue-entry:1',
    eventKey: 'turn_approaching',
    intentVersion: 1,
    idempotencyKey: 'enqueue-1',
    state: 'pending',
    payload: { locale: 'fr', places: 2 },
    supersededById: null,
    createdAt: '2026-09-11T00:00:00.000Z',
    supersededAt: null,
    dispatchAttemptCount: 2,
    dispatchLastAttemptAt: '2026-09-11T00:01:00.000Z',
    dispatchOutcomeAt: null,
    dispatchOutcomeCode: null,
    nextAttemptAt: null,
    dispatchMaxAttempts: 5,
    ...overrides,
  };
}

function claim(): NotificationDispatchClaim {
  return {
    intent: intent(),
    claimToken: 'claim-token-1',
    claimedAt: '2026-09-11T00:01:00.000Z',
    expiresAt: '2026-09-11T00:02:00.000Z',
  };
}

function store(options?: {
  claimed?: NotificationDispatchClaim | null;
  completed?: NotificationIntent | null;
}) {
  const claimed = options?.claimed === undefined ? claim() : options.claimed;
  const completed =
    options?.completed === undefined
      ? intent({ state: 'delivered' })
      : options.completed;
  const claimPendingIntent = vi.fn(async () => claimed);
  const completeDispatchAttempt = vi.fn(
    async (_input: CompleteNotificationDispatchInput) => completed,
  );
  return {
    value: {
      claimPendingIntent,
      completeDispatchAttempt,
    } satisfies NotificationDispatchStore,
    claimPendingIntent,
    completeDispatchAttempt,
  };
}

function provider(result: NotificationProviderResult) {
  const dispatch = vi.fn(async () => result);
  return {
    value: { dispatch } satisfies NotificationProviderAdapter,
    dispatch,
  };
}

describe('NotificationDispatchService', () => {
  it('emits deterministic privacy-safe events for persisted outcomes', async () => {
    const dispatchStore = store({
      completed: intent({
        state: 'failed',
        payload: { patientName: 'Sensitive Name', phone: '+213555000000' },
        nextAttemptAt: '2026-09-11T00:06:00.000Z',
        dispatchOutcomeCode: 'credential=secret',
      }),
    });
    const record = vi.fn();
    const service = new NotificationDispatchService(
      dispatchStore.value,
      provider({ kind: 'retryable_failure', code: 'credential=secret' }).value,
      60_000,
      { record },
    );

    await service.dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' });

    expect(record).toHaveBeenCalledWith({
      name: 'notification.dispatch.outcome',
      clinicId: 'clinic-1',
      intentId: 'intent-1',
      outcome: 'failed',
      attempt: 2,
      maxAttempts: 5,
      retryScheduled: true,
      exhausted: false,
    });
    expect(JSON.stringify(record.mock.calls)).not.toMatch(
      /Sensitive Name|\+213555000000|credential=secret|claim-token|notification:intent/,
    );
  });

  it('makes retry exhaustion observable from the persisted result', async () => {
    const record = vi.fn();
    const service = new NotificationDispatchService(
      store({
        completed: intent({
          state: 'dead_letter',
          dispatchAttemptCount: 5,
          dispatchMaxAttempts: 5,
        }),
      }).value,
      provider({ kind: 'retryable_failure' }).value,
      60_000,
      { record },
    );

    await service.dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'dead_letter',
        exhausted: true,
        retryScheduled: false,
      }),
    );
  });

  it.each([
    ['delivered', 'delivered'],
    ['retryable_failure', 'failed'],
    ['unknown', 'unknown'],
    ['terminal_failure', 'dead_letter'],
  ] as const)('maps %s to persisted %s', async (kind, outcome) => {
    const dispatchStore = store();
    const notificationProvider = provider({ kind, code: `provider_${kind}` });
    const service = new NotificationDispatchService(
      dispatchStore.value,
      notificationProvider.value,
    );

    await expect(
      service.dispatchOne({ clinicId: ' clinic-1 ', intentId: ' intent-1 ' }),
    ).resolves.toMatchObject({ status: 'completed' });

    expect(notificationProvider.dispatch).toHaveBeenCalledTimes(1);
    expect(notificationProvider.dispatch).toHaveBeenCalledWith({
      clinicId: 'clinic-1',
      intentId: 'intent-1',
      payload: { locale: 'fr', places: 2 },
      providerIdempotencyKey: 'notification:intent-1',
    });
    expect(dispatchStore.completeDispatchAttempt).toHaveBeenCalledWith({
      clinicId: 'clinic-1',
      intentId: 'intent-1',
      claimToken: 'claim-token-1',
      outcome,
      outcomeCode: `provider_${kind}`,
    });
  });

  it('records a thrown provider execution as unknown', async () => {
    const dispatchStore = store({ completed: intent({ state: 'unknown' }) });
    const dispatch = vi.fn(async () => {
      throw new Error('provider timeout');
    });
    const service = new NotificationDispatchService(dispatchStore.value, {
      dispatch,
    });

    await expect(
      service.dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' }),
    ).resolves.toMatchObject({
      status: 'completed',
      providerResult: { kind: 'unknown', code: 'provider_exception' },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchStore.completeDispatchAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'unknown',
        outcomeCode: 'provider_exception',
      }),
    );
  });

  it.each([
    null,
    { kind: 'unexpected' },
    { kind: 'delivered', code: { provider: 'bad-shape' } },
    { kind: 'delivered', code: 'x'.repeat(161) },
  ])(
    'records malformed fulfilled provider result %# as unknown',
    async (result) => {
      const dispatchStore = store({ completed: intent({ state: 'unknown' }) });
      const dispatch = vi.fn(
        async () => result,
      ) as unknown as NotificationProviderAdapter['dispatch'];
      const service = new NotificationDispatchService(dispatchStore.value, {
        dispatch,
      });

      await expect(
        service.dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' }),
      ).resolves.toMatchObject({
        status: 'completed',
        providerResult: {
          kind: 'unknown',
          code: 'provider_indeterminate_result',
        },
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatchStore.completeDispatchAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'unknown',
          outcomeCode: 'provider_indeterminate_result',
        }),
      );
    },
  );

  it('does not invoke a provider when the intent cannot be claimed', async () => {
    const dispatchStore = store({ claimed: null, completed: null });
    const notificationProvider = provider({ kind: 'delivered' });
    const service = new NotificationDispatchService(
      dispatchStore.value,
      notificationProvider.value,
    );

    await expect(
      service.dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' }),
    ).resolves.toEqual({ status: 'not_claimed' });
    expect(notificationProvider.dispatch).not.toHaveBeenCalled();
    expect(dispatchStore.completeDispatchAttempt).not.toHaveBeenCalled();
  });

  it('emits categorical not-claimed and claim-lost events without fence secrets', async () => {
    const notClaimedRecord = vi.fn();
    await new NotificationDispatchService(
      store({ claimed: null }).value,
      provider({ kind: 'delivered' }).value,
      60_000,
      { record: notClaimedRecord },
    ).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' });
    expect(notClaimedRecord).toHaveBeenCalledWith({
      name: 'notification.dispatch.not_claimed',
      clinicId: 'clinic-1',
      intentId: 'intent-1',
    });

    const claimLostRecord = vi.fn();
    await new NotificationDispatchService(
      store({ completed: null }).value,
      provider({ kind: 'unknown', code: 'private-provider-detail' }).value,
      60_000,
      { record: claimLostRecord },
    ).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' });
    expect(claimLostRecord).toHaveBeenCalledWith({
      name: 'notification.dispatch.claim_lost',
      clinicId: 'clinic-1',
      intentId: 'intent-1',
      providerResultKind: 'unknown',
    });
    expect(JSON.stringify(claimLostRecord.mock.calls)).not.toContain(
      'private-provider-detail',
    );
  });

  it('reports claim loss when completion is fenced after provider execution', async () => {
    const dispatchStore = store({ completed: null });
    const notificationProvider = provider({
      kind: 'delivered',
      code: 'accepted',
    });
    const service = new NotificationDispatchService(
      dispatchStore.value,
      notificationProvider.value,
    );

    await expect(
      service.dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' }),
    ).resolves.toEqual({
      status: 'claim_lost',
      claimToken: 'claim-token-1',
      providerIdempotencyKey: 'notification:intent-1',
      providerResult: { kind: 'delivered', code: 'accepted' },
    });
    expect(notificationProvider.dispatch).toHaveBeenCalledTimes(1);
  });

  it('uses a stable non-payload provider idempotency key across retries', async () => {
    const firstClaim = claim();
    firstClaim.intent.payload = {
      locale: 'ar',
      places: 1,
      displayLabel: 'A-42',
    };
    const retryClaim = claim();
    retryClaim.intent.dispatchAttemptCount = 3;
    retryClaim.claimToken = 'claim-token-2';
    retryClaim.intent.payload = {
      locale: 'fr',
      places: 1,
      displayLabel: 'B-43',
    };

    const firstStore = store({ claimed: firstClaim });
    const retryStore = store({ claimed: retryClaim });
    const firstProvider = provider({ kind: 'unknown' });
    const retryProvider = provider({ kind: 'delivered' });

    const firstResult = await new NotificationDispatchService(
      firstStore.value,
      firstProvider.value,
    ).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' });
    const retryResult = await new NotificationDispatchService(
      retryStore.value,
      retryProvider.value,
    ).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' });

    expect(firstResult).toMatchObject({
      providerIdempotencyKey: 'notification:intent-1',
    });
    expect(retryResult).toMatchObject({
      providerIdempotencyKey: 'notification:intent-1',
    });
    expect(JSON.stringify(firstResult)).not.toContain('A-42');
    expect(JSON.stringify(retryResult)).not.toContain('B-43');
  });
});
