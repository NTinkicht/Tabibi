import { expect, test } from '@playwright/test';

test('explains ETA uncertainty and privacy in French by default', async ({ page }) => {
  await page.goto('/guest/eta-explained');

  await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Comprendre vos estimations Tabibi' }),
  ).toBeVisible();
  await expect(
    page.getByText(/ne constituent pas une heure de passage garantie/),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Temps d’attente' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Consultation en cours' }),
  ).toBeVisible();
  await expect(page.getByText(/ni identité d’un autre patient/)).toBeVisible();
});

test('provides equivalent accessible Arabic RTL guidance', async ({ page }) => {
  await page.goto('/guest/eta-explained?lang=ar');

  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'فهم تقديرات طبيبي' }),
  ).toBeVisible();
  await expect(page.getByText(/وليست موعدًا مضمونًا للدخول/)).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'وقت الانتظار' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'الاستشارة جارية' }),
  ).toBeVisible();
  await expect(page.getByText(/هوية أي مريض آخر/)).toBeVisible();
});
