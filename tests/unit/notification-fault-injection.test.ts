import { describe, expect, it, vi } from 'vitest';
import type {
  NotificationDeliveryContextResolver,
  NotificationDispatchObserver,
  NotificationDispatchRenderer,
  NotificationDispatchStore,
  NotificationProviderAdapter,
  NotificationProviderDispatchContext,
  RenderedNotificationDispatchEnvelope,
} from '@/modules/notification-domain';
import { NotificationDispatchService } from '@/modules/notification-domain';
import { InAppNotificationProviderAdapter } from '@/modules/notification-inbox/provider-adapter';
import type { InAppNotificationInboxStore } from '@/modules/notification-inbox';
import type {
  NotificationDispatchClaim,
  NotificationIntent,
} from '@/modules/notification-outbox';

function providerContext(): NotificationProviderDispatchContext {
  return {
    clinicId: 'clinic-fault-1',
    deliveryContext: {
      target: {
        subjectKind: 'visit_patient',
        subjectId: 'patient-fault-1',
        channel: 'in_app',
      },
      preference: {
        id: 'pref-fault-1',
        clinicId: 'clinic-fault-1',
        subjectKind: 'visit_patient',
        subjectId: 'patient-fault-1',
        channel: 'in_app',
        preferenceState: 'enabled',
        consentState: 'not_required',
        revision: 1,
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z',
      },
    },
  };
}

function envelope(): RenderedNotificationDispatchEnvelope {
  return {
    channel: 'in_app',
    locale: 'fr',
    direction: 'ltr',
    templateId: 'turn_approaching.v1',
    title: 'Votre tour approche',
    body: 'Il reste 2 passage(s) avant votre tour.',
    providerIdempotencyKey: 'notification:fault-1',
  };
}

function dispatchIntent(
  overrides: Partial<NotificationIntent> = {},
): NotificationIntent {
  return {
    id: 'intent-fault-1',
    clinicId: 'clinic-fault-1',
    queueEntryId: null,
    logicalTargetKey: 'queue-entry:fault-1',
    eventKey: 'turn_approaching',
    intentVersion: 1,
    idempotencyKey: 'enqueue-fault-1',
    state: 'pending',
    payload: { locale: 'fr', places: 2 },
    supersededById: null,
    createdAt: '2026-09-14T00:00:00.000Z',
    supersededAt: null,
    dispatchAttemptCount: 1,
    dispatchLastAttemptAt: '2026-09-14T00:01:00.000Z',
    dispatchOutcomeAt: null,
    dispatchOutcomeCode: null,
    nextAttemptAt: null,
    dispatchMaxAttempts: 5,
    ...overrides,
  };
}

function dispatchClaim(): NotificationDispatchClaim {
  return {
    intent: dispatchIntent(),
    claimToken: 'claim-fault-1',
    claimedAt: '2026-09-14T00:01:00.000Z',
    expiresAt: '2026-09-14T00:02:00.000Z',
  };
}

function deliveryContext(): NotificationDeliveryContextResolver {
  return {
    resolve: vi.fn(async () => providerContext().deliveryContext),
  };
}

function renderer(): NotificationDispatchRenderer {
  return {
    renderAuthorized: vi.fn(async () => ({
      ...envelope(),
      channel: 'sms' as const,
    })),
  };
}

function dispatchService(input: {
  store: NotificationDispatchStore;
  provider: NotificationProviderAdapter;
  observer?: NotificationDispatchObserver;
}) {
  return new NotificationDispatchService(
    input.store,
    input.provider,
    deliveryContext(),
    60_000,
    input.observer,
    renderer(),
  );
}

describe('WU44 notification fault injection', () => {
  it('never reports delivered when inbox persistence throws an infrastructure fault', async () => {
    const secretDiagnostic = 'postgres password=do-not-leak';
    const persist = vi.fn(async () => {
      throw new Error(secretDiagnostic);
    });
    const inbox = {
      persist,
      listForSubject: vi.fn(),
      markRead: vi.fn(),
      unreadCount: vi.fn(),
    } satisfies InAppNotificationInboxStore;

    const result = await new InAppNotificationProviderAdapter(inbox).dispatch(
      envelope(),
      providerContext(),
    );

    expect(result).toEqual({
      kind: 'unknown',
      code: 'in_app_persist_exception',
    });
    expect(result).not.toMatchObject({ kind: 'delivered' });
    expect(JSON.stringify(result)).not.toContain(secretDiagnostic);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('normalizes a thrown provider/network-style failure and persists only a bounded unknown outcome', async () => {
    const secretDiagnostic = 'provider token=never-persist-this';
    const claimPendingIntent = vi.fn(async () => dispatchClaim());
    const completeDispatchAttempt = vi.fn(async () =>
      dispatchIntent({
        state: 'unknown',
        dispatchOutcomeCode: 'provider_exception',
      }),
    );
    const dispatch = vi.fn(async () => {
      throw new Error(secretDiagnostic);
    });
    const record = vi.fn();

    const result = await dispatchService({
      store: { claimPendingIntent, completeDispatchAttempt },
      provider: { dispatch },
      observer: { record },
    }).dispatchOne({
      clinicId: 'clinic-fault-1',
      intentId: 'intent-fault-1',
    });

    expect(result).toMatchObject({
      status: 'completed',
      providerResult: { kind: 'unknown', code: 'provider_exception' },
      intent: { state: 'unknown' },
    });
    expect(completeDispatchAttempt).toHaveBeenCalledWith({
      clinicId: 'clinic-fault-1',
      intentId: 'intent-fault-1',
      claimToken: 'claim-fault-1',
      outcome: 'unknown',
      outcomeCode: 'provider_exception',
    });
    expect(JSON.stringify(completeDispatchAttempt.mock.calls)).not.toContain(
      secretDiagnostic,
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(secretDiagnostic);
  });

  it('surfaces a claim-store database fault before provider invocation', async () => {
    const claimPendingIntent = vi.fn(async () => {
      throw new Error('claim database unavailable');
    });
    const completeDispatchAttempt = vi.fn();
    const dispatch = vi.fn();

    await expect(
      dispatchService({
        store: { claimPendingIntent, completeDispatchAttempt },
        provider: { dispatch },
      }).dispatchOne({
        clinicId: 'clinic-fault-1',
        intentId: 'intent-fault-1',
      }),
    ).rejects.toThrow('claim database unavailable');

    expect(dispatch).not.toHaveBeenCalled();
    expect(completeDispatchAttempt).not.toHaveBeenCalled();
  });

  it('surfaces a completion-store database fault after provider invocation instead of reporting success', async () => {
    const claimPendingIntent = vi.fn(async () => dispatchClaim());
    const completeDispatchAttempt = vi.fn(async () => {
      throw new Error('completion database unavailable');
    });
    const dispatch = vi.fn(async () => ({
      kind: 'delivered' as const,
      code: 'accepted',
    }));

    await expect(
      dispatchService({
        store: { claimPendingIntent, completeDispatchAttempt },
        provider: { dispatch },
      }).dispatchOne({
        clinicId: 'clinic-fault-1',
        intentId: 'intent-fault-1',
      }),
    ).rejects.toThrow('completion database unavailable');

    expect(dispatch).toHaveBeenCalledOnce();
    expect(completeDispatchAttempt).toHaveBeenCalledWith({
      clinicId: 'clinic-fault-1',
      intentId: 'intent-fault-1',
      claimToken: 'claim-fault-1',
      outcome: 'delivered',
      outcomeCode: 'accepted',
    });
  });
});
