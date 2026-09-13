import { describe, expect, it, vi } from 'vitest';
import {
  NotificationDispatchService,
  type NotificationDispatchRenderer,
  type NotificationDispatchStore,
} from '@/modules/notification-domain';
import {
  InAppNotificationProviderAdapter,
  type InAppNotificationRoutingScope,
} from '@/modules/notification-inbox/provider-adapter';
import type { InAppNotificationInboxStore } from '@/modules/notification-inbox';
import type {
  CompleteNotificationDispatchInput,
  NotificationDispatchClaim,
  NotificationIntent,
} from '@/modules/notification-outbox';
import type { NotificationPreference } from '@/modules/notification-preferences';

function intent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    id: 'intent-in-app-1',
    clinicId: 'clinic-1',
    queueEntryId: null,
    logicalTargetKey: 'queue-entry:1',
    eventKey: 'turn_approaching',
    intentVersion: 1,
    idempotencyKey: 'enqueue-in-app-1',
    state: 'pending',
    payload: { locale: 'fr', places: 2 },
    supersededById: null,
    createdAt: '2026-09-13T00:00:00.000Z',
    supersededAt: null,
    dispatchAttemptCount: 1,
    dispatchLastAttemptAt: '2026-09-13T00:01:00.000Z',
    dispatchOutcomeAt: null,
    dispatchOutcomeCode: null,
    nextAttemptAt: null,
    dispatchMaxAttempts: 5,
    ...overrides,
  };
}

function preference(
  overrides: Partial<NotificationPreference> = {},
): NotificationPreference {
  return {
    id: 'pref-in-app-1',
    clinicId: 'clinic-1',
    subjectKind: 'visit_patient',
    subjectId: 'patient-1',
    channel: 'in_app',
    preferenceState: 'enabled',
    consentState: 'granted',
    revision: 1,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...overrides,
  };
}

function dispatchStore(completedState: NotificationIntent['state']) {
  const claim: NotificationDispatchClaim = {
    intent: intent(),
    claimToken: 'claim-in-app-1',
    claimedAt: '2026-09-13T00:01:00.000Z',
    expiresAt: '2026-09-13T00:02:00.000Z',
  };
  return {
    claimPendingIntent: vi.fn(async () => claim),
    completeDispatchAttempt: vi.fn(
      async (_input: CompleteNotificationDispatchInput) =>
        intent({ state: completedState }),
    ),
  } satisfies NotificationDispatchStore;
}

function renderer(): NotificationDispatchRenderer {
  return {
    renderAuthorized: vi.fn(async ({ providerIdempotencyKey }) => ({
      channel: 'in_app' as const,
      locale: 'fr' as const,
      direction: 'ltr' as const,
      templateId: 'turn_approaching.v1' as const,
      title: 'Votre tour approche',
      body: 'Il reste 2 passage(s) avant votre tour.',
      providerIdempotencyKey,
    })),
  };
}

function inboxStore() {
  const persist = vi.fn(async (input) => ({
    id: 'inbox-1',
    clinicId: input.clinicId,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    providerIdempotencyKey: input.envelope.providerIdempotencyKey,
    templateId: input.envelope.templateId,
    locale: input.envelope.locale,
    direction: input.envelope.direction,
    title: input.envelope.title,
    body: input.envelope.body,
    createdAt: '2026-09-13T00:01:00.000Z',
  }));
  return { persist, listForSubject: vi.fn() } satisfies InAppNotificationInboxStore;
}

const scope: InAppNotificationRoutingScope = {
  clinicId: 'clinic-1',
  subjectKind: 'visit_patient',
  subjectId: 'patient-1',
};

function deliveryContext(currentPreference: NotificationPreference) {
  return {
    resolve: vi.fn(async () => ({
      target: {
        subjectKind: 'visit_patient' as const,
        subjectId: 'patient-1',
        channel: 'in_app' as const,
      },
      preference: currentPreference,
    })),
  };
}

describe('WU33 in-app provider adapter composition', () => {
  it('persists one bounded inbox write for authorized in_app dispatch through the existing service', async () => {
    const inbox = inboxStore();
    const adapter = new InAppNotificationProviderAdapter(inbox, scope);
    const dispatch = vi.spyOn(adapter, 'dispatch');

    const result = await new NotificationDispatchService(
      dispatchStore('delivered'),
      adapter,
      deliveryContext(preference()),
      60_000,
      undefined,
      renderer(),
    ).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-in-app-1' });

    expect(result).toMatchObject({ status: 'completed' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(inbox.persist).toHaveBeenCalledTimes(1);
    expect(inbox.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: 'clinic-1',
        subjectKind: 'visit_patient',
        subjectId: 'patient-1',
        envelope: expect.objectContaining({
          channel: 'in_app',
          providerIdempotencyKey: 'notification:intent-in-app-1',
        }),
      }),
    );
  });

  it('invokes neither renderer nor adapter when current consent is revoked', async () => {
    const inbox = inboxStore();
    const adapter = new InAppNotificationProviderAdapter(inbox, scope);
    const dispatch = vi.spyOn(adapter, 'dispatch');
    const notificationRenderer = renderer();

    const result = await new NotificationDispatchService(
      dispatchStore('suppressed'),
      adapter,
      deliveryContext(preference({ consentState: 'revoked' })),
      60_000,
      undefined,
      notificationRenderer,
    ).dispatchOne({ clinicId: 'clinic-1', intentId: 'intent-in-app-1' });

    expect(result).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'consent_revoked',
    });
    expect(notificationRenderer.renderAuthorized).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(inbox.persist).not.toHaveBeenCalled();
  });

  it('rejects non-in_app envelopes without persistence', async () => {
    const inbox = inboxStore();
    const adapter = new InAppNotificationProviderAdapter(inbox, scope);

    await expect(
      adapter.dispatch({
        channel: 'sms',
        locale: 'fr',
        direction: 'ltr',
        templateId: 'turn_approaching.v1',
        title: 'Votre tour approche',
        body: 'Il reste 2 passage(s) avant votre tour.',
        providerIdempotencyKey: 'notification:intent-in-app-1',
      }),
    ).resolves.toEqual({
      kind: 'terminal_failure',
      code: 'in_app_channel_mismatch',
    });
    expect(inbox.persist).not.toHaveBeenCalled();
  });
});
