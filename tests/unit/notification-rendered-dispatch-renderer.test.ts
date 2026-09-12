import { describe, expect, it, vi } from 'vitest';
import type { NotificationIntent } from '@/modules/notification-outbox';
import type { NotificationDeliveryContext } from '@/modules/notification-domain/delivery-policy';
import {
  NotificationTemplateDispatchRenderer,
  type NotificationDispatchTemplateInputResolver,
} from '@/modules/notification-domain/rendered-dispatch-renderer';

const intent: NotificationIntent = {
  id: 'intent-1',
  clinicId: 'clinic-1',
  queueEntryId: null,
  logicalTargetKey: 'queue-entry:1',
  eventKey: 'turn_approaching',
  intentVersion: 3,
  idempotencyKey: 'enqueue-1',
  state: 'pending',
  payload: { locale: 'fr', places: 2, patientName: 'Sensitive Name' },
  supersededById: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  supersededAt: null,
  dispatchAttemptCount: 1,
  dispatchLastAttemptAt: '2026-09-12T00:01:00.000Z',
  dispatchOutcomeAt: null,
  dispatchOutcomeCode: null,
  nextAttemptAt: null,
  dispatchMaxAttempts: 5,
};

const context: NotificationDeliveryContext = {
  target: {
    subjectKind: 'visit_patient',
    subjectId: 'patient-1',
    channel: 'sms',
  },
  preference: {
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
  },
};

describe('NotificationTemplateDispatchRenderer', () => {
  it('reuses the strict WU28 renderer and returns only the bounded provider envelope', async () => {
    const resolveTemplateInput = vi.fn(async () => ({
      templateId: 'turn_approaching.v1' as const,
      sourceIntentVersion: 3,
      locale: 'fr',
      variables: { position: 2 },
    }));
    const renderer = new NotificationTemplateDispatchRenderer({
      resolveTemplateInput,
    } satisfies NotificationDispatchTemplateInputResolver);

    await expect(
      renderer.renderAuthorized({
        intent,
        deliveryContext: context,
        providerIdempotencyKey: 'notification:intent-1',
      }),
    ).resolves.toEqual({
      channel: 'sms',
      locale: 'fr',
      direction: 'ltr',
      templateId: 'turn_approaching.v1',
      title: 'Votre tour approche',
      body: 'Il reste 2 passage(s) avant votre tour.',
      providerIdempotencyKey: 'notification:intent-1',
    });

    expect(resolveTemplateInput).toHaveBeenCalledWith({
      intent,
      deliveryContext: context,
    });
    expect(JSON.stringify(await renderer.renderAuthorized({
      intent,
      deliveryContext: context,
      providerIdempotencyKey: 'notification:intent-1',
    }))).not.toMatch(/Sensitive Name|patient-1|clinic-1/);
  });

  it('propagates strict render validation failure before any provider boundary exists', async () => {
    const renderer = new NotificationTemplateDispatchRenderer({
      resolveTemplateInput: vi.fn(async () => ({
        templateId: 'turn_approaching.v1' as const,
        sourceIntentVersion: 3,
        locale: 'ar',
        variables: { position: -1 },
      })),
    });

    await expect(
      renderer.renderAuthorized({
        intent,
        deliveryContext: context,
        providerIdempotencyKey: 'notification:intent-1',
      }),
    ).rejects.toThrow('Invalid notification template variables');
  });
});
