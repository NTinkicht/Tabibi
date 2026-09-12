import { describe, expect, it } from 'vitest';
import {
  composeGuestTransferExchangeLink,
  renderNotificationTemplate,
} from '@/modules/notification-templates';

describe('notification template integration boundary', () => {
  it.each(['session_cancelled.v1', 'queue_entry_cancelled.v1'] as const)(
    'renders terminal intent %s without identity data',
    (templateId) => {
      const rendered = renderNotificationTemplate({
        templateId,
        sourceIntentVersion: 12,
        locale: 'ar',
        variables: {},
      });
      expect(rendered.sourceIntentVersion).toBe(12);
      expect(JSON.stringify(rendered)).not.toMatch(
        /patient|contact|token|clinicId/i,
      );
    },
  );

  it('preserves a superseding source intent version separately from copy version', () => {
    const rendered = renderNotificationTemplate({
      templateId: 'session_delayed.v1',
      sourceIntentVersion: 43,
      variables: { delayMinutes: 30 },
    });
    expect(rendered).toMatchObject({
      templateVersion: 1,
      sourceIntentVersion: 43,
    });
  });

  it('keeps decrypted transfer links out of the general renderer', () => {
    expect(() =>
      renderNotificationTemplate({
        templateId: 'queue_entry_transferred.v1',
        sourceIntentVersion: 5,
        variables: {},
        exchangeUrl: 'https://tabibi.example/g/exchange/opaque_123',
      } as never),
    ).toThrow('Invalid notification template input');
  });

  it('allows the exchange link only through the dedicated post-decryption path', () => {
    const base = renderNotificationTemplate({
      templateId: 'queue_entry_transferred.v1',
      sourceIntentVersion: 5,
      variables: {},
    });
    const rendered = composeGuestTransferExchangeLink(
      base,
      'https://tabibi.example/g/exchange/opaque_123',
    );
    expect(rendered.body).toContain('/g/exchange/opaque_123');
    expect(rendered.sourceIntentVersion).toBe(5);
  });

  it.each([
    ['diagnosis', 'clinical detail'],
    ['rawContact', '+213555555555'],
    ['guestBearerToken', 'credential'],
    ['providerSecret', 'secret'],
  ])('rejects sensitive field %s at the strict root boundary', (key, value) => {
    expect(() =>
      renderNotificationTemplate({
        templateId: 'patient_called.v1',
        sourceIntentVersion: 1,
        variables: {},
        [key]: value,
      } as never),
    ).toThrow('Invalid notification template input');
  });
});
