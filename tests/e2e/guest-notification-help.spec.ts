import { expect, test } from '@playwright/test';

test('guest notification help is bilingual and privacy-minimal', async ({ page }) => {
  await page.goto('/guest/notification-help');
  const french = page.locator('section[lang="fr"]');
  const arabic = page.locator('section[lang="ar"]');
  await expect(french.getByRole('heading', { name: 'Comprendre les notifications Tabibi' })).toBeVisible();
  await expect(arabic).toHaveAttribute('dir', 'rtl');
  await expect(arabic.getByRole('heading', { name: 'فهم إشعارات طبيبي' })).toBeVisible();
  await expect(french.getByRole('link', { name: 'Revenir au statut' })).toHaveAttribute('href', '/guest/status');
  await expect(arabic.getByRole('link', { name: 'العودة إلى الحالة' })).toHaveAttribute('href', '/guest/status');
  const text = await page.locator('body').innerText();
  expect(text.toLowerCase()).not.toContain('bearer');
  expect(text.toLowerCase()).not.toContain('token');
});
