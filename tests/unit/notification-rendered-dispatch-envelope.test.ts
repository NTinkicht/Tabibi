import { describe, expect, it } from 'vitest';
import { createRenderedNotificationDispatchEnvelope } from '@/modules/notification-domain/rendered-dispatch-envelope';

describe('createRenderedNotificationDispatchEnvelope', () => {
  it('copies only the bounded rendered fields and deterministic provider key', () => {
    expect(
      createRenderedNotificationDispatchEnvelope({
        channel: 'sms',
        providerIdempotencyKey: ' notification:intent-1 ',
        rendered: {
          templateId: 'turn_approaching.v1',
          templateVersion: 1,
          sourceIntentVersion: 3,
          locale: 'fr',
          direction: 'ltr',
          title: 'Votre tour approche',
          body: 'Il reste 2 passage(s) avant votre tour.',
        },
      }),
    ).toEqual({
      channel: 'sms',
      locale: 'fr',
      direction: 'ltr',
      templateId: 'turn_approaching.v1',
      title: 'Votre tour approche',
      body: 'Il reste 2 passage(s) avant votre tour.',
      providerIdempotencyKey: 'notification:intent-1',
    });
  });

  it('preserves Arabic direction/content without adding source metadata', () => {
    const envelope = createRenderedNotificationDispatchEnvelope({
      channel: 'whatsapp',
      providerIdempotencyKey: 'notification:intent-ar',
      rendered: {
        templateId: 'patient_called.v1',
        templateVersion: 1,
        sourceIntentVersion: 9,
        locale: 'ar',
        direction: 'rtl',
        title: 'حان دورك',
        body: 'يرجى التوجه إلى طاقم العيادة.',
      },
    });

    expect(envelope.direction).toBe('rtl');
    expect(envelope.title).toBe('حان دورك');
    expect(envelope.body).toBe('يرجى التوجه إلى طاقم العيادة.');
    expect(envelope).not.toHaveProperty('sourceIntentVersion');
    expect(envelope).not.toHaveProperty('templateVersion');
  });

  it('rejects a blank provider idempotency key', () => {
    expect(() =>
      createRenderedNotificationDispatchEnvelope({
        channel: 'push',
        providerIdempotencyKey: '   ',
        rendered: {
          templateId: 'appointment_confirmed.v1',
          templateVersion: 1,
          sourceIntentVersion: 1,
          locale: 'fr',
          direction: 'ltr',
          title: 'Rendez-vous confirmé',
          body: 'Votre rendez-vous est confirmé.',
        },
      }),
    ).toThrow('Provider idempotency key is required');
  });
});
