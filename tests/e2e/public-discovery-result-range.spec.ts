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

async function mockMixedDirectory(
  page: Page,
  frenchCount: number,
  arabicOnlyCount: number,
) {
  const frenchClinics = Array.from({ length: frenchCount }, (_, index) => ({
    name: `Clinique ${index + 1}`,
    defaultLocale: 'fr',
    enabledLocales: ['fr'],
    doctors: [{ displayName: 'Dr. Public' }],
    tenantKey: 'private-range-tenant',
    id: 'private-range-clinic',
  }));
  const arabicOnlyClinics = Array.from(
    { length: arabicOnlyCount },
    (_, index) => ({
      name: `عيادة ${index + 1}`,
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'د. عام' }],
      tenantKey: 'private-range-tenant',
      id: 'private-range-clinic',
    }),
  );
  const clinics = [...frenchClinics, ...arabicOnlyClinics];
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
  expect(await page.locator('main').innerText()).not.toContain(
    'private-range-tenant',
  );
  expect(await page.locator('main').innerText()).not.toContain(
    'private-range-clinic',
  );
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
  expect(await page.locator('main').innerText()).not.toContain(
    'private-range-tenant',
  );
  expect(page.url()).not.toContain('private-range-clinic');
});

test('visible clinic total reports the true match count, not the revealed batch, once a filter yields more matches than one batch', async ({
  page,
}) => {
  await mockMixedDirectory(page, 7, 3);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();

  await page.getByLabel('Langue proposée par la clinique').selectOption('fr');

  const range = page.getByTestId('clinic-result-range');
  const visibleTotal = page.getByTestId('visible-clinic-total');
  await expect(page.locator('.publicClinic')).toHaveCount(6);
  await expect(range).toHaveText(
    'Résultats affichés : 1 à 6 sur 7 cliniques correspondantes.',
  );
  await expect(visibleTotal).toHaveText(
    'Affichage : 6 sur 10 cliniques du répertoire.',
  );

  await page.getByTestId('show-more-clinics').click();
  await expect(page.locator('.publicClinic')).toHaveCount(7);
  await expect(range).toHaveText(
    'Résultats affichés : 1 à 7 sur 7 cliniques correspondantes.',
  );
  await expect(visibleTotal).toHaveText(
    'Affichage : 7 sur 10 cliniques du répertoire.',
  );
});

test('French keyboard reveal focuses first newly shown clinic and never steals search focus', async ({
  page,
}) => {
  await mockDirectory(page, 'fr', 8);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();

  const showMore = page.getByTestId('show-more-clinics');
  await showMore.focus();
  await showMore.press('Enter');

  const newlyRevealedHeading = page
    .locator('.publicClinic')
    .nth(6)
    .getByRole('heading', { level: 3, name: 'Clinique 7' });
  await expect(newlyRevealedHeading).toBeFocused();
  await expect(page.locator('.publicClinic')).toHaveCount(8);
  await expect(showMore).toHaveCount(0);
  await expect(page.getByTestId('clinic-result-range')).toHaveText(
    'Résultats affichés : 1 à 8 sur 8 cliniques correspondantes.',
  );

  const search = page.getByRole('searchbox', {
    name: 'Rechercher une clinique ou un médecin',
  });
  await search.fill('Clinique 7');
  await expect(page.locator('.publicClinic')).toHaveCount(1);
  await expect(search).toBeFocused();
  await search.press('Escape');
  await expect(page.locator('.publicClinic')).toHaveCount(6);
  await expect(search).toBeFocused();
  expect(await page.locator('main').innerText()).not.toContain(
    'private-range-tenant',
  );
});

test('Arabic RTL keyboard reveal focuses the first newly shown clinic on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, 'ar', 8);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();

  const showMore = page.getByTestId('show-more-clinics');
  await showMore.focus();
  await showMore.press('Enter');
  await expect(
    page
      .locator('.publicClinic')
      .nth(6)
      .getByRole('heading', { level: 3, name: 'عيادة 7' }),
  ).toBeFocused();
  await expect(showMore).toHaveCount(0);
  await expect(page.getByTestId('clinic-result-range')).toHaveText(
    'النتائج المعروضة: من 1 إلى 8 من أصل 8 عيادات مطابقة.',
  );
  expect(await page.locator('main').innerText()).not.toContain(
    'private-range-clinic',
  );
});
