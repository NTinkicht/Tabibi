import { expect, test } from '@playwright/test';

test('regional Arabic ETA deep links render Arabic RTL guidance', async ({
  page,
}) => {
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

test('unknown locale does not accidentally select Arabic', async ({
  page,
}) => {
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

test('ETA explainer never echoes unrelated private query parameters', async ({
  page,
}) => {
  const sentinel = 'private-guest-bearer-sentinel';
  await page.goto(
    `/guest/eta-explained?lang=AR-DZ&unused=${sentinel}`,
  );
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  expect(await page.locator('main').innerText()).not.toContain(sentinel);
  await page.getByRole('link', { name: 'Français' }).click();
  await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
  expect(page.url()).not.toContain(sentinel);
});
