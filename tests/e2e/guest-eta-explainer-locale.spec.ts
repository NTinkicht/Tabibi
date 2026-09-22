import { expect, test } from '@playwright/test';

test('Arabic regional ETA links render RTL', async ({ page }) => {
  for (const lang of ['ar', 'AR-DZ', 'ar_ae']) {
    await page.goto(`/guest/eta-explained?lang=${lang}`);
    await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 1, name: 'فهم تقديرات طبيبي' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'آخر تحقق من الحالة' }),
    ).toBeVisible();
  }
});

test('Unknown ETA locale falls back to French', async ({ page }) => {
  for (const lang of ['argentina', 'en-US', 'fr']) {
    await page.goto(`/guest/eta-explained?lang=${lang}`);
    await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Comprendre vos estimations Tabibi',
      }),
    ).toBeVisible();
  }
});

test('ETA explainer does not echo private search params', async ({ page }) => {
  const sentinel = 'private-guest-bearer-sentinel';
  await page.goto(`/guest/eta-explained?lang=AR-DZ&unused=${sentinel}`);
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  expect(await page.locator('main').innerText()).not.toContain(sentinel);
  await page.getByRole('link', { name: 'Français' }).click();
  await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
  expect(page.url()).not.toContain(sentinel);
});

test('ETA active language link is announced', async ({ page }) => {
  const french = page.getByRole('link', { name: 'Français' });
  const arabic = page.getByRole('link', { name: 'العربية' });
  await page.goto('/guest/eta-explained?lang=fr');
  await expect(french).toHaveAttribute('aria-current', 'page');
  await expect(arabic).not.toHaveAttribute('aria-current');

  await arabic.click();
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(arabic).toHaveAttribute('aria-current', 'page');
  await expect(french).not.toHaveAttribute('aria-current');

  await french.click();
  await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
  await expect(french).toHaveAttribute('aria-current', 'page');
  await expect(arabic).not.toHaveAttribute('aria-current');
});

test('Regional Arabic deep links mark Arabic as current', async ({ page }) => {
  await page.goto('/guest/eta-explained?lang=AR-DZ');
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  const arabic = page.getByRole('link', { name: 'العربية' });
  const french = page.getByRole('link', { name: 'Français' });
  await expect(arabic).toHaveAttribute('aria-current', 'page');
  await expect(french).not.toHaveAttribute('aria-current');
});
