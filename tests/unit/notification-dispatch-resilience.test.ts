import { describe, expect, it, vi } from 'vitest';
import {
  NotificationDispatchService,
  NotificationIntentTemplateInputResolver,
  type NotificationDispatchStore,
  type NotificationProviderAdapter,
} from '@/modules/notification-domain';
import type {
  CompleteNotificationDispatchInput,
  NotificationDispatchClaim,
  NotificationIntent,
} from '@/modules/notification-outbox';

function intent(
  overrides: Partial<NotificationIntent> = {},
): NotificationIntent {
  return {
    id: 'intent-1',
    clinicId: 'clinic-1',
    queueEntryId: null,
    logicalTargetKey: 'queue-entry:1',
    eventKey: 'turn_approaching',
    intentVersion: 3,
    idempotencyKey: 'enqueue-1',
    state: 'pending',
    payload: { locale: 'fr', position: 2 },
    supersededById: null,
    createdAt: '2026-09-12T00:00:00.000Z',
    supersededAt: null,
    dispatchAttemptCount: 5,
    dispatchLastAttemptAt: '2026-09-12T00:01:00.000Z',
    dispatchOutcomeAt: null,
    dispatchOutcomeCode: null,
    nextAttemptAt: null,
    dispatchMaxAttempts: 5,
    ...overrides,
  };
}

function claim(value = intent()): NotificationDispatchClaim {
  return {
    intent: value,
    claimToken: 'claim-token-1',
    claimedAt: '2026-09-12T00:01:00.000Z',
    expiresAt: '2026-09-12T00:02:00.000Z',
  };
}

describe('WU31 notification dispatch resilience', () => {
  it('persists a bounded resolver failure and permits exhaustion to terminal dead-letter', async () => {
    const terminal = intent({
      state: 'dead_letter',
      dispatchOutcomeCode: 'delivery_context_failure',
      dispatchOutcomeAt: '2026-09-12T00:01:30.000Z',
    });
    const completeDispatchAttempt = vi.fn(
      async (_input: CompleteNotificationDispatchInput) => terminal,
    );
    const dispatchStore = {
      claimPendingIntent: vi.fn(async () => claim()),
      completeDispatchAttempt,
    } satisfies NotificationDispatchStore;
    const provider = {
      dispatch: vi.fn(),
    } satisfies NotificationProviderAdapter;
    const resolver = {
      resolve: vi.fn(async () => {
        throw new Error('Sensitive resolver detail');
      }),
    };
    const renderer = { renderAuthorized: vi.fn() };

    const result = await new NotificationDispatchService(
      dispatchStore,
      provider,
      resolver,
      60_000,
      undefined,
      renderer,
    ).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' });

    expect(result).toMatchObject({
      status: 'completed',
      providerResult: {
        kind: 'retryable_failure',
        code: 'delivery_context_failure',
      },
      intent: { state: 'dead_letter' },
    });
    expect(completeDispatchAttempt).toHaveBeenCalledWith({
      clinicId: 'clinic-1',
      intentId: 'intent-1',
      claimToken: 'claim-token-1',
      outcome: 'failed',
      outcomeCode: 'delivery_context_failure',
    });
    expect(provider.dispatch).not.toHaveBeenCalled();
    expect(renderer.renderAuthorized).not.toHaveBeenCalled();
    expect(JSON.stringify(completeDispatchAttempt.mock.calls)).not.toContain(
      'Sensitive resolver detail',
    );
  });

  it('preserves claim fencing when resolver-failure completion loses the claim', async () => {
    const dispatchStore = {
      claimPendingIntent: vi.fn(async () => claim()),
      completeDispatchAttempt: vi.fn(async () => null),
    } satisfies NotificationDispatchStore;

    await expect(
      new NotificationDispatchService(
        dispatchStore,
        { dispatch: vi.fn() },
        {
          resolve: vi.fn(async () => {
            throw new Error('resolver unavailable');
          }),
        },
      ).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' }),
    ).resolves.toMatchObject({
      status: 'claim_lost',
      claimToken: 'claim-token-1',
      providerResult: {
        kind: 'retryable_failure',
        code: 'delivery_context_failure',
      },
    });
  });

  it('pins guest-transfer rendering to fail closed until secure exchange-link composition exists', async () => {
    const resolver = new NotificationIntentTemplateInputResolver();

    await expect(
      resolver.resolveTemplateInput({
        intent: intent({
          eventKey: 'queue_entry_transferred',
          payload: { locale: 'fr' },
        }),
        deliveryContext: {
          target: {
            subjectKind: 'visit_patient',
            subjectId: 'patient-1',
            channel: 'sms',
          },
          preference: null,
        },
      }),
    ).rejects.toThrow(
      'Guest transfer notification requires secure exchange-link composition',
    );
  });
});
