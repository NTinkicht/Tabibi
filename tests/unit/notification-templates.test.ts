import { describe, expect, it } from 'vitest';
import {
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

  it('renders stable French copy and version provenance', () => {
    expect(
      renderNotificationTemplate({
        templateId: 'estimate_changed_materially.v1',
        sourceIntentVersion: 7,
        locale: 'fr-DZ',
        variables: { etaMinutes: 18 },
      }),
    ).toEqual({
      templateId: 'estimate_changed_materially.v1',
      templateVersion: 1,
      sourceIntentVersion: 7,
      locale: 'fr',
      direction: 'ltr',
      title: 'Mise à jour de l’attente',
      body: 'Le temps d’attente estimé est de 18 minutes.',
    });
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
