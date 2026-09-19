import { expect, test, type Page } from '@playwright/test';

const DISCOVERY_URL = '**/api/public/discovery';

async function mockDirectory(page: Page, clinics: unknown[]) {
  await page.route(DISCOVERY_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ clinics }),
    });
  });
}

test('root discovery displays public clinic and doctor names only', async ({
  page,
}) => {
  await mockDirectory(page, [
    {
      name: 'Clinique Étoile',
      defaultLocale: 'fr',
      enabledLocales: ['fr', 'ar'],
      tenantKey: 'private-tenant-key',
      id: 'private-clinic-id',
      doctors: [
        {
          displayName: 'Dr. Amine',
          id: 'private-doctor-id',
          userId: 'private-user-id',
          role: 'clinic_admin',
        },
      ],
    },
  ]);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tabibi' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Clinique Étoile' }),
  ).toBeVisible();
  await expect(page.getByText('Dr. Amine')).toBeVisible();
  await expect(page.getByText('Français · العربية')).toBeVisible();
  const body = await page.locator('main').innerText();
  for (const secret of [
    'private-tenant-key',
    'private-clinic-id',
    'private-doctor-id',
    'private-user-id',
    'clinic_admin',
  ]) {
    expect(body).not.toContain(secret);
  }
  await expect(page.locator('main a')).toHaveCount(0);
});

test('empty discovery is a helpful state, not a booking promise', async ({
  page,
}) => {
  await mockDirectory(page, []);
  await page.goto('/');
  await expect(
    page.getByText('Aucune clinique à afficher pour le moment.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Réessayer' })).toHaveCount(0);
});

test('a failed discovery read is retryable on the same page', async ({
  page,
}) => {
  let attempts = 0;
  await page.route(DISCOVERY_URL, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 503, body: 'unavailable' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        clinics: [
          {
            name: 'Clinique du Centre',
            defaultLocale: 'fr',
            enabledLocales: ['fr'],
            doctors: [],
          },
        ],
      }),
    });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText(
    'Le répertoire est momentanément indisponible.',
  );
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(
    page.getByRole('heading', { name: 'Clinique du Centre' }),
  ).toBeVisible();
  await expect(page.getByText('Aucun médecin affiché pour le moment.')).toBeVisible();
  expect(attempts).toBe(2);
});

test('Arabic directory uses RTL on a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, [
    {
      name: 'عيادة الأمل',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'د. مريم' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ابحث عن عيادتك' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'عيادة الأمل' })).toBeVisible();
  await expect(page.getByText('د. مريم')).toBeVisible();
  await expect(page.getByRole('button', { name: 'العربية' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
