import { expect, test, type Page } from '@playwright/test';

const DISCOVERY_URL = '**/api/public/discovery';
const PRIVATE_MARKER = 'private-browser-locale-clinic';

async function mockPublicDirectory(page: Page) {
  await page.route(DISCOVERY_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        clinics: [
          {
            name: 'Clinique publique',
            defaultLocale: 'fr',
            enabledLocales: ['fr', 'ar'],
            doctors: [{ displayName: 'Dr. Public' }],
            tenantKey: PRIVATE_MARKER,
            id: PRIVATE_MARKER,
          },
        ],
      }),
    }),
  );
}

for (const browserLanguage of ['ar-DZ', 'AR_ae']) {
  test(
    `Arabic browser ${browserLanguage} opens public directory in RTL without language click`,
    async ({ page }) => {
      await page.addInitScript((language) => {
        Object.defineProperty(navigator, 'language', {
          configurable: true,
          value: language,
        });
      }, browserLanguage);
      await page.setViewportSize({ width: 390, height: 844 });
      await mockPublicDirectory(page);
      await page.goto('/');
      await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'العربية' }),
      ).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: 'تحديث' }).click();
      await expect(page.locator('.publicClinic')).toHaveCount(1);

      const search = page.getByRole('searchbox', {
        name: 'ابحث عن عيادة أو طبيب',
      });
      await search.fill('Clinique');
      await page.getByLabel('ترتيب العيادات حسب الاسم').selectOption('ascending');
      await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();

      // A deliberate switch remains authoritative through later interactions.
      await page.getByRole('button', { name: 'Français' }).click();
      await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
      await page.getByRole('button', { name: 'Actualiser' }).click();
      await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Français' }),
      ).toHaveAttribute('aria-pressed', 'true');
      expect(await page.locator('main').innerText()).not.toContain(
        PRIVATE_MARKER,
      );
      expect(page.url()).not.toContain(PRIVATE_MARKER);
    },
  );
}

test(
  'Non-Arabic browser uses French directory and supports deliberate Arabic choice',
  async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'language', {
        configurable: true,
        value: 'en-US',
      });
    });
    await mockPublicDirectory(page);
    await page.goto('/');
    await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
    await page.getByRole('button', { name: 'العربية' }).click();
    await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
    await page.getByRole('button', { name: 'تحديث' }).click();
    await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
    expect(await page.locator('main').innerText()).not.toContain(
      PRIVATE_MARKER,
    );
  },
);
