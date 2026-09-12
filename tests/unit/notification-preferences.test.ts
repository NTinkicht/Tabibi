import { describe, expect, it } from 'vitest';
import {
  isNotificationDeliveryEligible,
  type NotificationPreference,
} from '@/modules/notification-preferences';

function preference(
  overrides: Partial<NotificationPreference> = {},
): NotificationPreference {
  return {
    id: 'preference-id',
    clinicId: 'clinic-id',
    subjectKind: 'visit_patient',
    subjectId: 'patient-id',
    channel: 'sms',
    preferenceState: 'enabled',
    consentState: 'granted',
    revision: 1,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('notification delivery eligibility', () => {
  it('fails closed for missing, disabled, mismatched, denied and revoked preferences', () => {
    expect(isNotificationDeliveryEligible('sms', null)).toBe(false);
    expect(
      isNotificationDeliveryEligible(
        'fax' as Parameters<typeof isNotificationDeliveryEligible>[0],
        preference(),
      ),
    ).toBe(false);
    expect(
      isNotificationDeliveryEligible(
        'sms',
        preference({ preferenceState: 'disabled' }),
      ),
    ).toBe(false);
    expect(
      isNotificationDeliveryEligible('email', preference({ channel: 'sms' })),
    ).toBe(false);
    expect(
      isNotificationDeliveryEligible(
        'sms',
        preference({ consentState: 'denied' }),
      ),
    ).toBe(false);
    expect(
      isNotificationDeliveryEligible(
        'sms',
        preference({ consentState: 'revoked' }),
      ),
    ).toBe(false);
  });

  it('requires grants for external channels and not-required consent for in-app', () => {
    expect(isNotificationDeliveryEligible('sms', preference())).toBe(true);
    expect(
      isNotificationDeliveryEligible(
        'in_app',
        preference({ channel: 'in_app', consentState: 'not_required' }),
      ),
    ).toBe(true);
    expect(
      isNotificationDeliveryEligible(
        'in_app',
        preference({ channel: 'in_app', consentState: 'granted' }),
      ),
    ).toBe(false);
  });
});
