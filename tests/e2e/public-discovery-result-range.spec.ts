import { expect, test, type Page } from '@playwright/test';

const DISCOVERY_URL = '**/api/public/discovery';

async function mockDirectory(page: Page, locale: 'fr' | 'ar', count: number) {
  const clinics = Array.from({ length: count }, (_, index) => ({
    name: locale === 'fr' ? `Clinique ${index + 1}` : `عيادة ${index + 1}`,
    defaultLocale: locale,
    enabledLocales: [locale],
    doctors: [{ displayName: locale === 'fr' ? 'Dr. Public' : 'د. عام' }],
    tenantKey: 'private-range-tenant',
    id: 'private-range-clinic',
  }));
  await page.route(DISCOVERY_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ clinics }),
    }),
  );
}

test('French result range reveals public clinics in bounded batches and resets on search', async ({
  page,
}) => {
  await mockDirectory(page, 'fr', 8);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();

  const range = page.getByTestId('clinic-result-range');
  await expect(range).toHaveText(
    'Résultats affichés : 1 à 6 sur 8 cliniques correspondantes.',
  );
  await expect(page.locator('.publicClinic')).toHaveCount(6);
  const showMore = page.getByTestId('show-more-clinics');
  await expect(showMore).toHaveText('Afficher 2 autres cliniques');
  await showMore.click();
  await expect(page.locator('.publicClinic')).toHaveCount(8);
  await expect(range).toHaveText(
    'Résultats affichés : 1 à 8 sur 8 cliniques correspondantes.',
  );
  await expect(showMore).toHaveCount(0);

  const search = page.getByRole('searchbox', {
    name: 'Rechercher une clinique ou un médecin',
  });
  await search.fill('Clinique 7');
  await expect(range).toHaveText(
    'Résultats affichés : 1 à 1 sur 1 clinique correspondante.',
  );
  await expect(page.locator('.publicClinic')).toHaveCount(1);
  await search.fill('aucune clinique');
  await expect(range).toHaveText(
    'Aucun résultat parmi 0 cliniques correspondantes.',
  );
  await expect(page.locator('.publicClinic')).toHaveCount(0);
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(page.locator('.publicClinic')).toHaveCount(6);
  await expect(range).toHaveText(
    'Résultats affichés : 1 à 6 sur 8 cliniques correspondantes.',
  );
  expect(await page.locator('main').innerText()).not.toContain('private-range-tenant');
  expect(await page.locator('main').innerText()).not.toContain('private-range-clinic');
});

test('Arabic RTL mobile result range respects sorting, filters and public-data boundary', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, 'ar', 7);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  const range = page.getByTestId('clinic-result-range');
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(range).toHaveText(
    'النتائج المعروضة: من 1 إلى 6 من أصل 7 عيادة مطابقة.',
  );
  await page.getByTestId('show-more-clinics').click();
  await expect(range).toHaveText(
    'النتائج المعروضة: من 1 إلى 7 من أصل 7 عيادة مطابقة.',
  );
  const search = page.getByRole('searchbox', {
    name: 'ابحث عن عيادة أو طبيب',
  });
  await search.fill('عيادة 7');
  await expect(range).toHaveText(
    'النتائج المعروضة: من 1 إلى 1 من أصل 1 عيادة مطابقة.',
  );
  await expect(page.locator('.publicClinic')).toHaveCount(1);
  await search.fill('لا تطابق');
  await expect(range).toHaveText('لا توجد نتائج معروضة من أصل 0 عيادة مطابقة.');
  await search.press('Escape');
  await expect(page.locator('.publicClinic')).toHaveCount(6);
  await expect(range).toHaveText(
    'النتائج المعروضة: من 1 إلى 6 من أصل 7 عيادة مطابقة.',
  );
  expect(await page.locator('main').innerText()).not.toContain('private-range-tenant');
  expect(page.url()).not.toContain('private-range-clinic');
});
