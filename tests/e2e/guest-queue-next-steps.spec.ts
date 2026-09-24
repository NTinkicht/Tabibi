import { expect, test } from '@playwright/test';

test('queue next steps are bilingual, RTL-aware and link to arrival guidance', async ({ page }) => {
  await page.goto('/guest/queue-next-steps');
  const french = page.locator('section[lang="fr"]');
  const arabic = page.locator('section[lang="ar"]');
  await expect(french.getByRole('heading', { name: 'Que faire pendant l’attente' })).toBeVisible();
  await expect(arabic).toHaveAttribute('dir', 'rtl');
  await expect(arabic.getByRole('heading', { name: 'ماذا تفعل أثناء الانتظار' })).toBeVisible();
  await expect(french.getByRole('listitem')).toHaveCount(3);
  await expect(arabic.getByRole('listitem')).toHaveCount(3);
  await expect(french.getByRole('link')).toHaveAttribute('href', '/guest/queue-arrival-help');
  await expect(arabic.getByRole('link')).toHaveAttribute('href', '/guest/queue-arrival-help');
});
