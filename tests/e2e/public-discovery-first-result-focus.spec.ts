import { expect, test, type Page } from '@playwright/test';

async function mockDirectory(page: Page, locale: 'fr' | 'ar') {
  const clinics = Array.from({ length: 8 }, (_, index) => ({
    name: locale === 'fr' ? `Clinique ${index + 1}` : `عيادة ${index + 1}`,
    defaultLocale: locale,
    enabledLocales: [locale],
    doctors: [{ displayName: locale === 'fr' ? 'Dr. Public' : 'د. عام' }],
    tenantKey: 'private-jump-tenant',
    id: 'private-jump-clinic-id',
  }));
  await page.route('**/api/public/discovery', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ clinics }),
    }),
  );
}

test('French jump focuses the first filtered clinic', async ({ page }) => {
  await mockDirectory(page, 'fr');
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  const jump = page.getByTestId('jump-to-first-clinic');
  await expect(jump).toHaveCount(0);

  const search = page.getByRole('searchbox', {
    name: 'Rechercher une clinique ou un médecin',
  });
  await search.fill('Clinique');
  const sort = page.getByLabel('Trier les cliniques par nom');
  await sort.selectOption('descending');
  await expect(jump).toHaveText('Aller au premier résultat');
  await jump.focus();
  await jump.press('Enter');
  await expect(
    page.locator('.publicClinic').first().getByRole('heading', {
      level: 3,
      name: 'Clinique 8',
    }),
  ).toBeFocused();

  const showMore = page.getByTestId('show-more-clinics');
  await showMore.focus();
  await showMore.press('Enter');
  await expect(
    page.locator('.publicClinic').nth(6).getByRole('heading', {
      level: 3,
      name: 'Clinique 2',
    }),
  ).toBeFocused();

  await search.fill('aucune correspondance');
  await expect(jump).toHaveCount(0);
  await search.press('Escape');
  await expect(jump).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toContain(
    'private-jump-tenant',
  );
});

test('Arabic RTL jump focuses first clinic', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, 'ar');
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();

  const jump = page.getByTestId('jump-to-first-clinic');
  await page.getByLabel('اللغة المتاحة في العيادة').selectOption('ar');
  await expect(jump).toHaveText('الانتقال إلى أول نتيجة');
  await jump.focus();
  await jump.press('Enter');
  await expect(
    page.locator('.publicClinic').first().getByRole('heading', {
      level: 3,
      name: 'عيادة 1',
    }),
  ).toBeFocused();

  await page.getByLabel('اللغة المتاحة في العيادة').selectOption('fr');
  await expect(page.locator('.publicClinic')).toHaveCount(0);
  await expect(jump).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toContain(
    'private-jump-clinic-id',
  );
});
