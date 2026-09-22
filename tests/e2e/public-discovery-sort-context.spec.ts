import { expect, test, type Page } from '@playwright/test';

async function mockClinics(page: Page, locale: 'fr' | 'ar') {
  const clinics = Array.from({ length: 8 }, (_, index) => ({
    name: locale === 'fr' ? `Clinique ${index + 1}` : `عيادة ${index + 1}`,
    defaultLocale: locale,
    enabledLocales: [locale],
    doctors: [{ displayName: locale === 'fr' ? 'Dr. Public' : 'د. عام' }],
    tenantKey: 'private-sort-tenant',
    id: 'private-sort-clinic-id',
  }));
  await page.route('**/api/public/discovery', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ clinics }),
    }),
  );
}

test('French directory announces active sort beside public results and preserves it across filter changes', async ({
  page,
}) => {
  await mockClinics(page, 'fr');
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  const sort = page.getByLabel('Trier les cliniques par nom');
  const summary = page.getByTestId('clinic-sort-context');
  await expect(summary).toHaveCount(0);

  await sort.selectOption('descending');
  await expect(summary).toHaveText('Cliniques classées par nom : Z à A.');
  await expect(page.locator('.publicClinic h3').first()).toHaveText(
    'Clinique 8',
  );
  await page.getByLabel('Langue proposée par la clinique').selectOption('fr');
  await expect(summary).toHaveText('Cliniques classées par nom : Z à A.');

  await sort.selectOption('ascending');
  await expect(summary).toHaveText('Cliniques classées par nom : A à Z.');
  await expect(page.locator('.publicClinic h3').first()).toHaveText(
    'Clinique 1',
  );
  await sort.selectOption('original');
  await expect(summary).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toContain(
    'private-sort-tenant',
  );
});

test('Arabic RTL public directory keeps sort context truthful through zero matches', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockClinics(page, 'ar');
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  const sort = page.getByLabel('ترتيب العيادات حسب الاسم');
  const summary = page.getByTestId('clinic-sort-context');
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();

  await sort.selectOption('descending');
  await expect(summary).toHaveText(
    'العيادات مرتبة حسب الاسم: تنازليًا.',
  );
  await expect(page.locator('.publicClinic h3').first()).toHaveText(
    'عيادة 8',
  );
  const search = page.getByRole('searchbox', {
    name: 'ابحث عن عيادة أو طبيب',
  });
  await search.fill('لا توجد');
  await expect(page.locator('.publicClinic')).toHaveCount(0);
  await expect(summary).toHaveCount(0);
  await search.press('Escape');
  await expect(summary).toHaveText(
    'العيادات مرتبة حسب الاسم: تنازليًا.',
  );
  await sort.selectOption('original');
  await expect(summary).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toContain(
    'private-sort-clinic-id',
  );
});
