import { expect, test, type Page } from '@playwright/test';

const DIRECTORY_URL = '**/api/public/discovery';
const PRIVATE_ID = 'private-collapse-clinic-id';

async function mockClinics(page: Page, locale: 'fr' | 'ar') {
  const clinics = Array.from({ length: 8 }, (_, index) => ({
    name: locale === 'fr' ? `Clinique ${index + 1}` : `عيادة ${index + 1}`,
    defaultLocale: locale,
    enabledLocales: [locale],
    doctors: [{ displayName: 'Dr. Public' }],
    tenantKey: PRIVATE_ID,
    id: PRIVATE_ID,
  }));
  await page.route(DIRECTORY_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ clinics }),
    }),
  );
}

test('French expanded public clinics collapse and restore keyboard focus', async ({
  page,
}) => {
  await mockClinics(page, 'fr');
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  const more = page.getByTestId('show-more-clinics');
  await more.focus();
  await more.press('Enter');
  await expect(
    page.locator('.publicClinic').nth(6).getByRole('heading', { level: 3 }),
  ).toBeFocused();
  await expect(page.locator('.publicClinic')).toHaveCount(8);
  const fewer = page.getByTestId('show-fewer-clinics');
  await expect(fewer).toHaveText('Afficher les 6 premières cliniques');
  await fewer.click();
  await expect(page.locator('.publicClinic')).toHaveCount(6);
  await expect(more).toBeFocused();
  await expect(fewer).toHaveCount(0);
  await expect(page.getByTestId('clinic-result-range')).toHaveText(
    'Résultats affichés : 1 à 6 sur 8 cliniques correspondantes.',
  );
  await more.click();
  await expect(page.locator('.publicClinic')).toHaveCount(8);
  expect(await page.locator('main').innerText()).not.toContain(PRIVATE_ID);
});

test('Arabic RTL mobile expanded public clinics collapse without lost focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'ar-DZ',
    });
  });
  await mockClinics(page, 'ar');
  await page.goto('/');
  await page.getByRole('button', { name: 'تحديث' }).click();
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  const more = page.getByTestId('show-more-clinics');
  await more.click();
  await expect(page.locator('.publicClinic')).toHaveCount(8);
  const fewer = page.getByTestId('show-fewer-clinics');
  await expect(fewer).toHaveText('عرض أول 6 عيادات');
  await fewer.click();
  await expect(page.locator('.publicClinic')).toHaveCount(6);
  await expect(more).toBeFocused();
  await expect(fewer).toHaveCount(0);
  await expect(page.getByTestId('clinic-result-range')).toHaveText(
    'النتائج المعروضة: من 1 إلى 6 من أصل 8 عيادة مطابقة.',
  );
  expect(await page.locator('main').innerText()).not.toContain(PRIVATE_ID);
});
