import { describe, expect, it } from 'vitest';
import { resolveNotificationTemplateLocale } from '@/modules/notification-templates';

describe('ISO-639-2 Arabic notification locale aliases', () => {
  it.each([
    ['ara', 'ar'],
    ['ARA_DZ', 'ar'],
    ['ara-AE', 'ar'],
    ['unknown', 'fr'],
  ] as const)('resolves %s to %s', (requested, expected) => {
    expect(resolveNotificationTemplateLocale(requested)).toBe(expected);
  });
});
