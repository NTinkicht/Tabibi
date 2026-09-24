import { expect, test } from '@playwright/test';

const ROUTES = [
  '/guest/booking-help',
  '/guest/booking-contact-help',
  '/guest/privacy-help',
  '/guest/notification-help',
  '/guest/queue-next-steps',
  '/guest/queue-arrival-help',
] as const;

test('guest help hub groups French and Arabic guidance by journey phase', async ({
  page,
}) => {
  await page.goto('/guest/help');
  const french = page.locator('section[lang="fr"][dir="ltr"]');
  const arabic = page.locator('section[lang="ar"][dir="rtl"]');

  await expect(
    french.getByRole('heading', { name: 'Aide pour votre parcours invité' }),
  ).toBeVisible();
  await expect(
    arabic.getByRole('heading', { name: 'مساعدة خلال رحلة الحجز كضيف' }),
  ).toBeVisible();
  await expect(french.getByRole('heading', { level: 2 })).toHaveText([
    'Avant la réservation',
    'Après la réservation',
  ]);
  await expect(arabic.getByRole('heading', { level: 2 })).toHaveText([
    'قبل الحجز',
    'بعد الحجز',
  ]);
  await expect(french.getByRole('listitem')).toHaveCount(7);
  await expect(arabic.getByRole('listitem')).toHaveCount(7);

  for (const route of ROUTES) {
    await expect(french.locator('a[href="' + route + '"]')).toHaveCount(1);
    await expect(arabic.locator('a[href="' + route + '"]')).toHaveCount(1);
  }
  await expect(
    french.locator('a[href="/guest/eta-explained?lang=fr"]'),
  ).toHaveCount(1);
  await expect(
    arabic.locator('a[href="/guest/eta-explained?lang=ar"]'),
  ).toHaveCount(1);
  expect(page.url()).not.toContain('private-guest-bearer-secret');
  await expect(page.locator('body')).not.toContainText(
    'private-guest-bearer-secret',
  );
});
