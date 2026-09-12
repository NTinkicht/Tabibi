import { describe, expect, it, vi } from 'vitest';
import type {
  CompleteNotificationDispatchInput,
  NotificationDispatchClaim,
  NotificationIntent,
} from '@/modules/notification-outbox';
import type { NotificationPreference } from '@/modules/notification-preferences';
import {
  NotificationDispatchService,
  type NotificationDeliveryContextResolver,
  type NotificationDispatchObserver,
  type NotificationDispatchRenderer,
  type NotificationDispatchStore,
  type NotificationProviderAdapter,
  type RenderedNotificationDispatchEnvelope,
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
    intentVersion: 3,
    idempotencyKey: 'enqueue-1',
    state: 'pending',
    payload: {
      locale: 'fr',
      places: 2,
      patientName: 'Sensitive Name',
      phone: '+213555000000',
    },
    supersededById: null,
    createdAt: '2026-09-12T00:00:00.000Z',
    supersededAt: null,
    dispatchAttemptCount: 1,
    dispatchLastAttemptAt: '2026-09-12T00:01:00.000Z',
    dispatchOutcomeAt: null,
    dispatchOutcomeCode: null,
    nextAttemptAt: null,
    dispatchMaxAttempts: 5,
    ...overrides,
  };
}

function claim(overrides: Partial<NotificationDispatchClaim> = {}) {
  return {
    intent: intent(),
    claimToken: 'claim-token-1',
    claimedAt: '2026-09-12T00:01:00.000Z',
    expiresAt: '2026-09-12T00:02:00.000Z',
    ...overrides,
  } satisfies NotificationDispatchClaim;
}

function preference(
  overrides: Partial<NotificationPreference> = {},
): NotificationPreference {
  return {
    id: 'preference-1',
    clinicId: 'clinic-1',
    subjectKind: 'visit_patient',
    subjectId: 'patient-1',
    channel: 'sms',
    preferenceState: 'enabled',
    consentState: 'granted',
    revision: 1,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

function context(options?: {
  preference?: NotificationPreference | null;
  channel?: 'in_app' | 'push' | 'sms' | 'email' | 'whatsapp';
}): NotificationDeliveryContextResolver {
  const channel = options?.channel ?? 'sms';
  const resolvedPreference =
    options && Object.prototype.hasOwnProperty.call(options, 'preference')
      ? (options.preference ?? null)
      : preference({ channel });

  return {
    resolve: vi.fn(async () => ({
      target: {
        subjectKind: 'visit_patient' as const,
        subjectId: 'patient-1',
        channel,
      },
      preference: resolvedPreference,
    })),
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

const frenchEnvelope: RenderedNotificationDispatchEnvelope = {
  channel: 'sms',
  locale: 'fr',
  direction: 'ltr',
  templateId: 'turn_approaching.v1',
  title: 'Votre tour approche',
  body: 'Il reste 2 passage(s) avant votre tour.',
  providerIdempotencyKey: 'notification:intent-1',
};

const arabicEnvelope: RenderedNotificationDispatchEnvelope = {
  channel: 'sms',
  locale: 'ar',
  direction: 'rtl',
  templateId: 'patient_called.v1',
  title: 'حان دورك',
  body: 'يرجى التوجه إلى طاقم العيادة.',
  providerIdempotencyKey: 'notification:intent-1',
};

function renderer(
  result: RenderedNotificationDispatchEnvelope = frenchEnvelope,
) {
  const renderAuthorized = vi.fn(async () => result);
  return {
    value: { renderAuthorized } satisfies NotificationDispatchRenderer,
    renderAuthorized,
  };
}

function provider(result: { kind: 'delivered' | 'unknown'; code?: string }) {
  const dispatch = vi.fn(async () => result);
  return {
    value: { dispatch } satisfies NotificationProviderAdapter,
    dispatch,
  };
}

function service(input: {
  dispatchStore: NotificationDispatchStore;
  notificationProvider: NotificationProviderAdapter;
  deliveryContext: NotificationDeliveryContextResolver;
  notificationRenderer: NotificationDispatchRenderer;
  observer?: NotificationDispatchObserver;
}) {
  return new NotificationDispatchService(
    input.dispatchStore,
    input.notificationProvider,
    input.deliveryContext,
    60_000,
    input.observer,
    input.notificationRenderer,
  );
}

describe('WU30 consent-gated rendered dispatch composition', () => {
  it('invokes neither renderer nor provider when current consent suppresses delivery', async () => {
    const dispatchStore = store({
      completed: intent({ state: 'suppressed' }),
    });
    const notificationRenderer = renderer();
    const notificationProvider = provider({ kind: 'delivered' });

    const result = await service({
      dispatchStore: dispatchStore.value,
      notificationProvider: notificationProvider.value,
      deliveryContext: context({
        preference: preference({ consentState: 'revoked' }),
      }),
      notificationRenderer: notificationRenderer.value,
    }).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' });

    expect(result).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'consent_revoked',
    });
    expect(notificationRenderer.renderAuthorized).not.toHaveBeenCalled();
    expect(notificationProvider.dispatch).not.toHaveBeenCalled();
  });

  it('renders exactly once after authorization and dispatches exactly one bounded envelope', async () => {
    const dispatchStore = store();
    const notificationRenderer = renderer();
    const notificationProvider = provider({
      kind: 'delivered',
      code: 'accepted',
    });

    await service({
      dispatchStore: dispatchStore.value,
      notificationProvider: notificationProvider.value,
      deliveryContext: context(),
      notificationRenderer: notificationRenderer.value,
    }).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' });

    expect(notificationRenderer.renderAuthorized).toHaveBeenCalledTimes(1);
    expect(notificationRenderer.renderAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        providerIdempotencyKey: 'notification:intent-1',
      }),
    );
    expect(notificationProvider.dispatch).toHaveBeenCalledTimes(1);
    expect(notificationProvider.dispatch).toHaveBeenCalledWith(frenchEnvelope);
    expect(
      JSON.stringify(notificationProvider.dispatch.mock.calls),
    ).not.toMatch(/Sensitive Name|\+213555000000|clinic-1|patient-1|claim-token/);
  });

  it('leaves renderer failure recoverable and invokes no provider or completion', async () => {
    const dispatchStore = store();
    const notificationProvider = provider({ kind: 'delivered' });
    const renderAuthorized = vi
      .fn()
      .mockRejectedValueOnce(new Error('Sensitive render failure'))
      .mockResolvedValueOnce(frenchEnvelope);
    const notificationRenderer = {
      renderAuthorized,
    } satisfies NotificationDispatchRenderer;

    const dispatchService = service({
      dispatchStore: dispatchStore.value,
      notificationProvider: notificationProvider.value,
      deliveryContext: context(),
      notificationRenderer,
    });

    await expect(
      dispatchService.dispatchOne({
        clinicId: 'clinic-1',
        intentId: 'intent-1',
      }),
    ).rejects.toThrow('Sensitive render failure');
    expect(notificationProvider.dispatch).not.toHaveBeenCalled();
    expect(dispatchStore.completeDispatchAttempt).not.toHaveBeenCalled();

    await expect(
      dispatchService.dispatchOne({
        clinicId: 'clinic-1',
        intentId: 'intent-1',
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(renderAuthorized).toHaveBeenCalledTimes(2);
    expect(notificationProvider.dispatch).toHaveBeenCalledTimes(1);
  });

  it('preserves claim fencing after successful rendering and provider execution', async () => {
    const dispatchStore = store({ completed: null });
    const notificationRenderer = renderer();
    const notificationProvider = provider({
      kind: 'delivered',
      code: 'accepted',
    });

    await expect(
      service({
        dispatchStore: dispatchStore.value,
        notificationProvider: notificationProvider.value,
        deliveryContext: context(),
        notificationRenderer: notificationRenderer.value,
      }).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' }),
    ).resolves.toEqual({
      status: 'claim_lost',
      claimToken: 'claim-token-1',
      providerIdempotencyKey: 'notification:intent-1',
      providerResult: { kind: 'delivered', code: 'accepted' },
    });
  });

  it('preserves provider unknown-result persistence after successful rendering', async () => {
    const dispatchStore = store({
      completed: intent({ state: 'unknown' }),
    });
    const notificationProvider = provider({ kind: 'unknown', code: 'timeout' });

    await service({
      dispatchStore: dispatchStore.value,
      notificationProvider: notificationProvider.value,
      deliveryContext: context(),
      notificationRenderer: renderer().value,
    }).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' });

    expect(dispatchStore.completeDispatchAttempt).toHaveBeenCalledWith({
      clinicId: 'clinic-1',
      intentId: 'intent-1',
      claimToken: 'claim-token-1',
      outcome: 'unknown',
      outcomeCode: 'timeout',
    });
  });

  it.each([frenchEnvelope, arabicEnvelope])(
    'passes deterministic %s rendered content only to the ephemeral adapter boundary',
    async (renderedEnvelope) => {
      const dispatchStore = store();
      const notificationProvider = provider({ kind: 'delivered' });
      const record = vi.fn();

      await service({
        dispatchStore: dispatchStore.value,
        notificationProvider: notificationProvider.value,
        deliveryContext: context(),
        notificationRenderer: renderer(renderedEnvelope).value,
        observer: { record },
      }).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' });

      expect(notificationProvider.dispatch).toHaveBeenCalledWith(
        renderedEnvelope,
      );
      expect(
        JSON.stringify(dispatchStore.completeDispatchAttempt.mock.calls),
      ).not.toContain(renderedEnvelope.body);
      expect(JSON.stringify(record.mock.calls)).not.toContain(
        renderedEnvelope.body,
      );
      expect(JSON.stringify(record.mock.calls)).not.toContain(
        renderedEnvelope.title,
      );
    },
  );

  it('fails closed on renderer/template mismatch before provider invocation', async () => {
    const dispatchStore = store();
    const notificationProvider = provider({ kind: 'delivered' });
    const renderAuthorized = vi.fn(async () => {
      throw new Error('Unsupported notification render event');
    });

    await expect(
      service({
        dispatchStore: dispatchStore.value,
        notificationProvider: notificationProvider.value,
        deliveryContext: context(),
        notificationRenderer: { renderAuthorized },
      }).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-1' }),
    ).rejects.toThrow('Unsupported notification render event');

    expect(notificationProvider.dispatch).not.toHaveBeenCalled();
    expect(dispatchStore.completeDispatchAttempt).not.toHaveBeenCalled();
  });
});
