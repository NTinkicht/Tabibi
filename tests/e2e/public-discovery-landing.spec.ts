import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

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
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect(page.getByRole('heading', { name: 'Tabibi' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Clinique Étoile' }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'Répertoire actualisé : 1 clinique.',
  );
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
  await page.getByRole('button', { name: 'Actualiser' }).click();
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
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect(page.locator('.publicNotice[role="alert"]')).toContainText(
    'Le répertoire est momentanément indisponible.',
  );
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(
    page.getByRole('heading', { name: 'Clinique du Centre' }),
  ).toBeVisible();
  await expect(
    page.getByText('Aucun médecin affiché pour le moment.'),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

test('a stalled directory refresh times out and the retry can recover', async ({
  page,
}) => {
  let attempts = 0;
  await page.route(DISCOVERY_URL, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 6_000));
      await route.abort().catch(() => {});
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        clinics: [
          {
            name: 'Clinique du Renouveau',
            defaultLocale: 'fr',
            enabledLocales: ['fr'],
            doctors: [{ displayName: 'Dr. Sami' }],
          },
        ],
      }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect(page.getByRole('button', { name: 'Actualiser' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible({
    timeout: 8_000,
  });
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(
    page.getByRole('heading', { name: 'Clinique du Renouveau' }),
  ).toBeVisible();
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
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'ابحث عن عيادتك' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'عيادة الأمل' }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'تم تحديث الدليل: 1 عيادة.',
  );
  await expect(page.getByText('د. مريم')).toBeVisible();
  await expect(page.getByRole('button', { name: 'العربية' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('initial HTML contains discoverable clinic names without client JavaScript', async ({
  request,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const clinicId = randomUUID();
  const publicName = `SSR Clinique ${clinicId.slice(0, 8)}`;
  const privateTenantKey = `never-public-${clinicId}`;
  try {
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name,status)
       VALUES($1,$2,$3,'active')`,
      [clinicId, privateTenantKey, publicName],
    );
    const response = await request.get('/');
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain(publicName);
    expect(html).not.toContain(clinicId);
    expect(html).not.toContain(privateTenantKey);
  } finally {
    await pool.query('DELETE FROM clinics WHERE id=$1', [clinicId]);
    await pool.end();
  }
});

test('filters public clinic and doctor names without leaking private IDs', async ({
  page,
}) => {
  await mockDirectory(page, [
    {
      name: 'Clinique Étoile',
      defaultLocale: 'fr',
      enabledLocales: ['fr', 'ar'],
      id: 'private-clinic-id',
      doctors: [{ displayName: 'Dr. Amine', id: 'private-doctor-id' }],
    },
    {
      name: 'Cabinet du Centre',
      defaultLocale: 'fr',
      enabledLocales: ['fr'],
      doctors: [{ displayName: 'Dr. Salima' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();

  const search = page.getByRole('searchbox', {
    name: 'Rechercher une clinique ou un médecin',
  });
  await search.fill('etoile');
  await expect(
    page.getByRole('heading', { name: 'Clinique Étoile' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Cabinet du Centre' }),
  ).toHaveCount(0);
  await expect(page.getByText('1 clinique trouvée.')).toBeVisible();

  await search.fill('SALIMA');
  await expect(
    page.getByRole('heading', { name: 'Cabinet du Centre' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Clinique Étoile' }),
  ).toHaveCount(0);
  await search.fill('does-not-exist');
  await expect(
    page.getByText(
      'Aucune clinique ni aucun médecin ne correspond à votre recherche.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Effacer la recherche' }).click();
  await expect(search).toHaveValue('');
  await expect(page.locator('.publicClinic')).toHaveCount(2);
  const body = await page.locator('main').innerText();
  expect(body).not.toContain('private-clinic-id');
  expect(body).not.toContain('private-doctor-id');
});

test('Arabic search matches without vowel marks and remains RTL', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, [
    {
      name: 'عِيَادَة الأمل',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'د. مريم' }],
    },
    {
      name: 'عيادة الورد',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'د. أحمد' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  const search = page.getByRole('searchbox', { name: 'ابحث عن عيادة أو طبيب' });
  await search.fill('عيادة الامل');
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'عِيَادَة الأمل' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'عيادة الورد' })).toHaveCount(
    0,
  );
  await expect(page.getByText('نتائج البحث: 1 عيادة.')).toBeVisible();

  await page.getByRole('button', { name: 'تحديث' }).click();
  await expect(search).toHaveValue('عيادة الامل');
  await expect(
    page.getByRole('heading', { name: 'عِيَادَة الأمل' }),
  ).toBeVisible();
});
