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

test('French ETA quick nav jumps to recovery', async ({ page }) => {
  const secret = 'private-guest-token-never-in-explainer';
  await page.goto('/guest/eta-explained?lang=fr');
  const quickNav = page.getByRole('navigation', { name: 'Sur cette page' });
  await expect(quickNav.getByRole('link')).toHaveCount(5);
  const recoveryLink = quickNav.getByRole('link', {
    name: 'Si le statut n’est plus à jour',
  });
  await recoveryLink.click();
  await expect(
    page.getByRole('heading', { name: 'Si le statut n’est plus à jour' }),
  ).toHaveAttribute('id', 'recovery-heading');
  await expect(page).toHaveURL(/#recovery-heading$/);
  expect(page.url()).not.toContain(secret);
  expect(await page.locator('main').innerText()).not.toContain(secret);
});

test('Arabic RTL ETA explainer jumps to last verified explanation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/guest/eta-explained?lang=AR-DZ');
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  const quickNav = page.getByRole('navigation', { name: 'في هذه الصفحة' });
  await expect(quickNav.getByRole('link')).toHaveCount(5);
  await quickNav.getByRole('link', { name: 'آخر تحقق من الحالة' }).click();
  await expect(
    page.getByRole('heading', { name: 'آخر تحقق من الحالة' }),
  ).toHaveAttribute('id', 'verification-heading');
  await expect(page).toHaveURL(/#verification-heading$/);
  await expect(
    page.getByRole('link', { name: 'العربية' }),
  ).toHaveAttribute('aria-current', 'page');
  expect(page.url()).not.toContain('private-guest-token');
});
