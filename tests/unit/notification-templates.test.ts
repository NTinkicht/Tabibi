import { describe, expect, it } from 'vitest';
import {
  composeGuestTransferExchangeLink,
  NotificationTemplateValidationError,
  notificationTemplateIds,
  renderNotificationTemplate,
  resolveNotificationTemplateLocale,
} from '@/modules/notification-templates';

describe('notification template rendering', () => {
  it.each([
    ['ar', 'ar'],
    ['ar-DZ', 'ar'],
    ['AR_dz', 'ar'],
    ['fr', 'fr'],
    ['fr-DZ', 'fr'],
    ['en', 'fr'],
    [undefined, 'fr'],
  ] as const)('resolves %s to %s', (requested, expected) => {
    expect(resolveNotificationTemplateLocale(requested)).toBe(expected);
  });

  it('renders waiting estimates as provisional French uncertainty windows', () => {
    expect(
      renderNotificationTemplate({
        templateId: 'estimate_changed_materially.v1',
        sourceIntentVersion: 7,
        locale: 'fr-DZ',
        variables: { windowStartMinutes: 12, windowEndMinutes: 24 },
      }),
    ).toEqual({
      templateId: 'estimate_changed_materially.v1',
      templateVersion: 1,
      sourceIntentVersion: 7,
      locale: 'fr',
      direction: 'ltr',
      title: 'Mise à jour de l’attente',
      body: 'Votre attente provisoire est estimée entre 12 et 24 minutes. Cette estimation peut évoluer.',
    });
  });

  it('renders Arabic waiting uncertainty with RTL metadata', () => {
    const rendered = renderNotificationTemplate({
      templateId: 'estimate_changed_materially.v1',
      sourceIntentVersion: 2,
      locale: 'ar-DZ',
      variables: { windowStartMinutes: 5, windowEndMinutes: 15 },
    });
    expect(rendered).toMatchObject({ locale: 'ar', direction: 'rtl' });
    expect(rendered.body).toContain('بين 5 و15 دقيقة');
  });

  it('does not present registration order as a live queue position', () => {
    const rendered = renderNotificationTemplate({
      templateId: 'queue_entry_created.v1',
      sourceIntentVersion: 3,
      locale: 'fr',
      variables: {},
    });
    expect(rendered.body).toContain('provisoire');
    expect(rendered.body).not.toMatch(/position|rang|\b\d+\b/i);
  });

  it('renders Arabic with RTL metadata', () => {
    const rendered = renderNotificationTemplate({
      templateId: 'turn_approaching.v1',
      sourceIntentVersion: 2,
      locale: 'ar-DZ',
      variables: { position: 1 },
    });
    expect(rendered).toMatchObject({ locale: 'ar', direction: 'rtl' });
    expect(rendered.body).toBe('تبقى 1 قبلك.');
  });

  it('keeps the complete v1 identifier set stable', () => {
    expect(notificationTemplateIds).toEqual([
      'appointment_confirmed.v1',
      'queue_entry_created.v1',
      'estimate_changed_materially.v1',
      'turn_approaching.v1',
      'patient_called.v1',
      'session_delayed.v1',
      'session_cancelled.v1',
      'queue_entry_cancelled.v1',
      'queue_entry_transferred.v1',
    ]);
  });

  it('composes only a narrow HTTPS guest exchange link after rendering', () => {
    const rendered = renderNotificationTemplate({
      templateId: 'queue_entry_transferred.v1',
      sourceIntentVersion: 9,
      locale: 'fr',
      variables: {},
    });
    const composed = composeGuestTransferExchangeLink(
      rendered,
      'https://tabibi.example/g/exchange/opaque_123',
    );
    expect(composed.body).toContain(
      'https://tabibi.example/g/exchange/opaque_123',
    );
  });

  it.each([
    'http://tabibi.example/g/exchange/opaque',
    'https://user:pass@tabibi.example/g/exchange/opaque',
    'https://tabibi.example/g/exchange/opaque?token=secret',
    'https://tabibi.example/g/exchange/opaque#secret',
    'https://tabibi.example/not-exchange/opaque',
  ])(
    'rejects malformed guest exchange link %s without reflecting it',
    (url) => {
      const rendered = renderNotificationTemplate({
        templateId: 'queue_entry_transferred.v1',
        sourceIntentVersion: 1,
        variables: {},
      });
      try {
        composeGuestTransferExchangeLink(rendered, url);
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(NotificationTemplateValidationError);
        expect(String(error)).not.toContain(url);
      }
    },
  );

  it('rejects attaching exchange links to other notification intents', () => {
    const rendered = renderNotificationTemplate({
      templateId: 'patient_called.v1',
      sourceIntentVersion: 1,
      variables: {},
    });
    expect(() =>
      composeGuestTransferExchangeLink(
        rendered,
        'https://tabibi.example/g/exchange/opaque_123',
      ),
    ).toThrow(NotificationTemplateValidationError);
  });

  it.each([
    null,
    [],
    { templateId: 'unknown-template', sourceIntentVersion: 1, variables: {} },
    {
      templateId: 'session_cancelled.v2',
      sourceIntentVersion: 1,
      variables: {},
    },
    {
      templateId: 'session_cancelled.v1',
      sourceIntentVersion: 0,
      variables: {},
    },
    {
      templateId: 'session_cancelled.v1',
      sourceIntentVersion: 1,
      variables: {},
      patientName: 'private',
    },
    {
      templateId: 'turn_approaching.v1',
      sourceIntentVersion: 1,
      variables: { position: -1 },
    },
    {
      templateId: 'turn_approaching.v1',
      sourceIntentVersion: 1,
      variables: { position: 1, token: 2 },
    },
    {
      templateId: 'estimate_changed_materially.v1',
      sourceIntentVersion: 1,
      variables: { windowStartMinutes: 20, windowEndMinutes: 10 },
    },
    {
      templateId: 'queue_entry_created.v1',
      sourceIntentVersion: 1,
      variables: { position: 5 },
    },
  ])('rejects malformed or non-allowlisted input %#', (input) => {
    expect(() => renderNotificationTemplate(input as never)).toThrow(
      NotificationTemplateValidationError,
    );
  });

  it('does not reflect an unknown identifier in its error', () => {
    const secret = 'diagnosis-secret-template';
    expect(() =>
      renderNotificationTemplate({
        templateId: secret,
        sourceIntentVersion: 1,
        variables: {},
      } as never),
    ).toThrowError('Unsupported notification template');
    try {
      renderNotificationTemplate({
        templateId: secret,
        sourceIntentVersion: 1,
        variables: {},
      } as never);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
