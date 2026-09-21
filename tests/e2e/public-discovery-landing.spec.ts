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
  await expect(search).toBeFocused();
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

test('clinic search remains stable in Turkish browser locale', async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: 'tr-TR' });
  try {
    const page = await context.newPage();
    await mockDirectory(page, [
      {
        name: 'Istanbul Clinic',
        defaultLocale: 'fr',
        enabledLocales: ['fr'],
        doctors: [],
      },
    ]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Actualiser' }).click();
    await page
      .getByRole('searchbox', { name: 'Rechercher une clinique ou un médecin' })
      .fill('istanbul');
    await expect(
      page.getByRole('heading', { name: 'Istanbul Clinic' }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test('clinic language and search compose without exposing IDs', async ({
  page,
}) => {
  await mockDirectory(page, [
    {
      name: 'Clinique Étoile',
      defaultLocale: 'fr',
      enabledLocales: ['fr', 'ar'],
      tenantKey: 'private-tenant',
      doctors: [{ displayName: 'Dr. Nora', id: 'private-doctor' }],
    },
    {
      name: 'Cabinet du Centre',
      defaultLocale: 'fr',
      enabledLocales: ['fr'],
      doctors: [{ displayName: 'Dr. Nora' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  const language = page.getByRole('combobox', {
    name: 'Langue proposée par la clinique',
  });
  const search = page.getByRole('searchbox', {
    name: 'Rechercher une clinique ou un médecin',
  });
  await language.selectOption('ar');
  await expect(page.locator('.publicClinic')).toHaveCount(1);
  await expect(page.getByText('1 clinique trouvée.')).toBeVisible();
  await search.fill('nora');
  await expect(
    page.getByRole('heading', { name: 'Clinique Étoile' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Cabinet du Centre' }),
  ).toHaveCount(0);
  await search.fill('centre');
  await expect(
    page.getByText('Aucune clinique ne correspond aux filtres sélectionnés.'),
  ).toBeVisible();
  await language.selectOption('all');
  await expect(
    page.getByRole('heading', { name: 'Cabinet du Centre' }),
  ).toBeVisible();
  await search.fill('');
  await expect(page.locator('.publicClinic')).toHaveCount(2);
  const body = await page.locator('main').innerText();
  expect(body).not.toContain('private-tenant');
  expect(body).not.toContain('private-doctor');
});

test('Arabic language filter remains RTL across refresh', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, [
    {
      name: 'عيادة الأمل',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [],
    },
    {
      name: 'عيادة السلام',
      defaultLocale: 'fr',
      enabledLocales: ['fr'],
      doctors: [],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  const language = page.getByRole('combobox', {
    name: 'اللغة المتاحة في العيادة',
  });
  await language.selectOption('ar');
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'عيادة الأمل' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'عيادة السلام' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'تحديث' }).click();
  await expect(language).toHaveValue('ar');
  await page.getByRole('button', { name: 'Français' }).click();
  await expect(
    page.getByRole('combobox', { name: 'Langue proposée par la clinique' }),
  ).toHaveValue('ar');
  await expect(page.getByText('1 clinique trouvée.')).toBeVisible();
});

test('reset all filters clears name and clinic language together', async ({
  page,
}) => {
  await mockDirectory(page, [
    {
      name: 'Clinique Étoile',
      defaultLocale: 'fr',
      enabledLocales: ['fr', 'ar'],
      tenantKey: 'private-tenant',
      doctors: [{ displayName: 'Dr. Amine', id: 'private-doctor' }],
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
  const language = page.getByRole('combobox', {
    name: 'Langue proposée par la clinique',
  });
  await language.selectOption('ar');
  await search.fill('centre');
  await expect(
    page.getByText('Aucune clinique ne correspond aux filtres sélectionnés.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Effacer tous les filtres' }).click();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(language).toHaveValue('all');
  await expect(page.locator('.publicClinic')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Effacer tous les filtres' }),
  ).toHaveCount(0);
  const body = await page.locator('main').innerText();
  expect(body).not.toContain('private-tenant');
  expect(body).not.toContain('private-doctor');
});

test('Arabic one-tap reset clears the language-only filter in RTL', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, [
    {
      name: 'عيادة الأمل',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [],
    },
    {
      name: 'عيادة الورد',
      defaultLocale: 'fr',
      enabledLocales: ['fr'],
      doctors: [],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  const language = page.getByRole('combobox', {
    name: 'اللغة المتاحة في العيادة',
  });
  await language.selectOption('fr');
  await expect(page.locator('.publicClinic')).toHaveCount(1);
  await page.getByRole('button', { name: 'مسح جميع عوامل التصفية' }).click();
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(language).toHaveValue('all');
  await expect(page.locator('.publicClinic')).toHaveCount(2);
  await expect(
    page.getByRole('searchbox', { name: 'ابحث عن عيادة أو طبيب' }),
  ).toBeFocused();
});

test('clinic name sorting composes with name and language filters', async ({
  page,
}) => {
  await mockDirectory(page, [
    {
      name: 'Clinique Étoile',
      defaultLocale: 'fr',
      enabledLocales: ['fr', 'ar'],
      doctors: [{ displayName: 'Dr. Salem' }],
    },
    {
      name: 'Clinique Zéphyr',
      defaultLocale: 'fr',
      enabledLocales: ['fr'],
      tenantKey: 'private-tenant-sort',
      doctors: [{ displayName: 'Dr. Salem', id: 'private-doctor-sort' }],
    },
    {
      name: 'Clinique Alpha',
      defaultLocale: 'fr',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'Dr. Rayan' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  const names = page.locator('.publicClinic h3');
  const sort = page.getByRole('combobox', {
    name: 'Trier les cliniques par nom',
  });
  await expect(names).toHaveText([
    'Clinique Étoile',
    'Clinique Zéphyr',
    'Clinique Alpha',
  ]);
  await sort.selectOption('ascending');
  await expect(names).toHaveText([
    'Clinique Alpha',
    'Clinique Étoile',
    'Clinique Zéphyr',
  ]);
  await sort.selectOption('descending');
  await expect(names).toHaveText([
    'Clinique Zéphyr',
    'Clinique Étoile',
    'Clinique Alpha',
  ]);
  await page
    .getByRole('searchbox', { name: 'Rechercher une clinique ou un médecin' })
    .fill('salem');
  await expect(names).toHaveText(['Clinique Zéphyr', 'Clinique Étoile']);
  await page
    .getByRole('combobox', { name: 'Langue proposée par la clinique' })
    .selectOption('ar');
  await expect(names).toHaveText(['Clinique Étoile']);
  await page.getByRole('button', { name: 'Effacer tous les filtres' }).click();
  await expect(sort).toHaveValue('descending');
  await expect(names).toHaveText([
    'Clinique Zéphyr',
    'Clinique Étoile',
    'Clinique Alpha',
  ]);
  const body = await page.locator('main').innerText();
  expect(body).not.toContain('private-tenant-sort');
  expect(body).not.toContain('private-doctor-sort');
  await sort.selectOption('original');
  await expect(names).toHaveText([
    'Clinique Étoile',
    'Clinique Zéphyr',
    'Clinique Alpha',
  ]);
});

test('Arabic sorting stays selected after locale switch and refresh', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, [
    {
      name: 'عيادة الورد',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [],
    },
    {
      name: 'عيادة الأمل',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  const sort = page.getByRole('combobox', {
    name: 'ترتيب العيادات حسب الاسم',
  });
  await sort.selectOption('ascending');
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.locator('.publicClinic h3')).toHaveText([
    'عيادة الأمل',
    'عيادة الورد',
  ]);
  await page.getByRole('button', { name: 'تحديث' }).click();
  await expect(sort).toHaveValue('ascending');
  await page.getByRole('button', { name: 'Français' }).click();
  await expect(
    page.getByRole('combobox', { name: 'Trier les cliniques par nom' }),
  ).toHaveValue('ascending');
});

test('listed-doctors filter composes with search, clinic language and sorting', async ({
  page,
}) => {
  await mockDirectory(page, [
    {
      name: 'Clinique Zulu',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'Dr. Aya' }],
    },
    {
      name: 'Clinique Beta',
      defaultLocale: 'fr',
      enabledLocales: ['fr'],
      doctors: [],
    },
    {
      name: 'Clinique Alpha',
      defaultLocale: 'fr',
      enabledLocales: ['fr', 'ar'],
      tenantKey: 'private-listed-tenant',
      doctors: [{ displayName: 'Dr. Amine', id: 'private-listed-doctor' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();

  const listed = page.getByRole('checkbox', {
    name: 'Cliniques avec médecins affichés uniquement',
  });
  const search = page.getByRole('searchbox', {
    name: 'Rechercher une clinique ou un médecin',
  });
  const language = page.getByRole('combobox', {
    name: 'Langue proposée par la clinique',
  });
  const sort = page.getByRole('combobox', {
    name: 'Trier les cliniques par nom',
  });
  const names = page.locator('.publicClinic h3');

  await listed.check();
  await expect(names).toHaveText(['Clinique Zulu', 'Clinique Alpha']);
  await expect(page.getByText('2 cliniques trouvées.')).toBeVisible();
  await sort.selectOption('ascending');
  await expect(names).toHaveText(['Clinique Alpha', 'Clinique Zulu']);
  await search.fill('amine');
  await language.selectOption('ar');
  await expect(names).toHaveText(['Clinique Alpha']);
  await search.fill('introuvable');
  await expect(
    page.getByText('Aucune clinique ne correspond aux filtres sélectionnés.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Effacer tous les filtres' }).click();
  await expect(listed).not.toBeChecked();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(language).toHaveValue('all');
  await expect(sort).toHaveValue('ascending');
  await expect(names).toHaveText([
    'Clinique Alpha',
    'Clinique Beta',
    'Clinique Zulu',
  ]);
  const body = await page.locator('main').innerText();
  expect(body).not.toContain('private-listed-tenant');
  expect(body).not.toContain('private-listed-doctor');
});

test('Arabic listed-doctors filter survives refresh and locale changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, [
    {
      name: 'عيادة الأمل',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [],
    },
    {
      name: 'عيادة الورد',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'د. نورة' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  const listed = page.getByRole('checkbox', {
    name: 'العيادات التي تعرض أطباء فقط',
  });
  await listed.check();
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.locator('.publicClinic h3')).toHaveText(['عيادة الورد']);
  await expect(page.getByText('نتائج البحث: 1 عيادة.')).toBeVisible();
  await page.getByRole('button', { name: 'تحديث' }).click();
  await expect(listed).toBeChecked();
  await expect(page.locator('.publicClinic h3')).toHaveText(['عيادة الورد']);
  await page.getByRole('button', { name: 'Français' }).click();
  await expect(
    page.getByRole('checkbox', {
      name: 'Cliniques avec médecins affichés uniquement',
    }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'العربية' }).click();
  await page.getByRole('button', { name: 'مسح جميع عوامل التصفية' }).click();
  await expect(listed).not.toBeChecked();
  await expect(page.locator('.publicClinic h3')).toHaveText([
    'عيادة الأمل',
    'عيادة الورد',
  ]);
});

test('clinic cards show public doctor counts for one and two names only', async ({
  page,
}) => {
  await mockDirectory(page, [
    {
      name: 'Clinique Sans Médecin',
      defaultLocale: 'fr',
      enabledLocales: ['fr'],
      doctors: [],
    },
    {
      name: 'Clinique Un',
      defaultLocale: 'fr',
      enabledLocales: ['fr', 'ar'],
      tenantKey: 'private-count-tenant',
      doctors: [{ displayName: 'Dr. Amina', id: 'private-count-doctor' }],
    },
    {
      name: 'Clinique Deux',
      defaultLocale: 'fr',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'Dr. Aya' }, { displayName: 'Dr. Imane' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  const noDoctor = page.locator('.publicClinic', {
    has: page.getByRole('heading', { name: 'Clinique Sans Médecin' }),
  });
  const oneDoctor = page.locator('.publicClinic', {
    has: page.getByRole('heading', { name: 'Clinique Un' }),
  });
  const twoDoctors = page.locator('.publicClinic', {
    has: page.getByRole('heading', { name: 'Clinique Deux' }),
  });
  await expect(
    noDoctor.getByText('Aucun médecin affiché pour le moment.'),
  ).toBeVisible();
  await expect(noDoctor.locator('.publicDoctorCount')).toHaveCount(0);
  await expect(oneDoctor.getByText('1 médecin affiché')).toBeVisible();
  await expect(twoDoctors.getByText('2 médecins affichés')).toBeVisible();
  await expect(oneDoctor.getByText('Dr. Amina')).toBeVisible();
  await expect(twoDoctors.locator('li')).toHaveCount(2);

  const listed = page.getByRole('checkbox', {
    name: 'Cliniques avec médecins affichés uniquement',
  });
  await listed.check();
  await expect(page.locator('.publicClinic')).toHaveCount(2);
  await page.getByRole('button', { name: 'Effacer tous les filtres' }).click();
  await expect(page.locator('.publicClinic')).toHaveCount(3);
  const body = await page.locator('main').innerText();
  expect(body).not.toContain('private-count-tenant');
  expect(body).not.toContain('private-count-doctor');
});

test('Arabic RTL doctor-count labels survive search sort and locale switch', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, [
    {
      name: 'عيادة الورد',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'د. أمينة' }],
    },
    {
      name: 'عيادة الأمل',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'د. مريم' }, { displayName: 'د. سارة' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.getByText('طبيب واحد في القائمة')).toBeVisible();
  await expect(page.getByText('طبيبان في القائمة')).toBeVisible();
  await page
    .getByRole('combobox', { name: 'ترتيب العيادات حسب الاسم' })
    .selectOption('ascending');
  await expect(page.locator('.publicClinic h3')).toHaveText([
    'عيادة الأمل',
    'عيادة الورد',
  ]);
  await page.getByRole('button', { name: 'Français' }).click();
  await expect(page.getByText('1 médecin affiché')).toBeVisible();
  await expect(page.getByText('2 médecins affichés')).toBeVisible();
  await page.getByRole('button', { name: 'العربية' }).click();
  await page.getByRole('button', { name: 'تحديث' }).click();
  await expect(page.getByText('طبيب واحد في القائمة')).toBeVisible();
  await expect(page.getByText('طبيبان في القائمة')).toBeVisible();
});

test('doctor-name search shows only matching public doctors inside a clinic card', async ({
  page,
}) => {
  await mockDirectory(page, [
    {
      name: 'Clinique Étoile',
      defaultLocale: 'fr',
      enabledLocales: ['fr', 'ar'],
      tenantKey: 'private-focus-tenant',
      doctors: [
        { displayName: 'Dr. Amine', id: 'private-focus-doctor-a' },
        { displayName: 'Dr. Salima', id: 'private-focus-doctor-b' },
        { displayName: 'Dr. Nora' },
      ],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  const search = page.getByRole('searchbox', {
    name: 'Rechercher une clinique ou un médecin',
  });
  const clinic = page.locator('.publicClinic');

  await search.fill('salima');
  await expect(clinic.getByText('Dr. Salima')).toBeVisible();
  await expect(clinic.getByText('Dr. Amine')).toHaveCount(0);
  await expect(clinic.getByText('Dr. Nora')).toHaveCount(0);
  await expect(clinic.getByText('1 médecin affiché')).toBeVisible();

  await search.fill('etoile');
  await expect(clinic.locator('li')).toHaveCount(3);
  await expect(clinic.getByText('3 médecins affichés')).toBeVisible();

  await page.getByRole('button', { name: 'Effacer tous les filtres' }).click();
  await expect(search).toBeFocused();
  await expect(clinic.locator('li')).toHaveCount(3);
  await expect(clinic.getByText('3 médecins affichés')).toBeVisible();
  const body = await page.locator('main').innerText();
  expect(body).not.toContain('private-focus-tenant');
  expect(body).not.toContain('private-focus-doctor-a');
  expect(body).not.toContain('private-focus-doctor-b');
});

test('Arabic doctor-only search ignores vowel marks and remains RTL', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, [
    {
      name: 'عيادة الورد',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'د. مَرْيَم' }, { displayName: 'د. سارة' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  const search = page.getByRole('searchbox', { name: 'ابحث عن عيادة أو طبيب' });
  const clinic = page.locator('.publicClinic');

  await search.fill('مريم');
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(clinic.getByText('د. مَرْيَم')).toBeVisible();
  await expect(clinic.getByText('د. سارة')).toHaveCount(0);
  await expect(clinic.getByText('طبيب واحد في القائمة')).toBeVisible();

  await page.getByRole('button', { name: 'مسح جميع عوامل التصفية' }).click();
  await expect(search).toBeFocused();
  await expect(clinic.locator('li')).toHaveCount(2);
  await expect(clinic.getByText('طبيبان في القائمة')).toBeVisible();
});

test('filtered public results count only doctors actually visible in clinic cards', async ({
  page,
}) => {
  await mockDirectory(page, [
    {
      name: 'Clinique Étoile',
      defaultLocale: 'fr',
      enabledLocales: ['fr', 'ar'],
      tenantKey: 'private-total-tenant',
      doctors: [
        { displayName: 'Dr. Amine', id: 'private-total-doctor' },
        { displayName: 'Dr. Salima' },
        { displayName: 'Dr. Nora' },
      ],
    },
    {
      name: 'Cabinet du Centre',
      defaultLocale: 'fr',
      enabledLocales: ['fr'],
      doctors: [{ displayName: 'Dr. Amine' }],
    },
    {
      name: 'Clinique Sans Médecin',
      defaultLocale: 'fr',
      enabledLocales: ['fr'],
      doctors: [],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();

  const total = page.getByText(
    /médecins? affichés? au total dans les résultats\./,
  );
  const search = page.getByRole('searchbox', {
    name: 'Rechercher une clinique ou un médecin',
  });
  await expect(total).toHaveCount(0);
  await search.fill('amine');
  await expect(page.getByText('2 cliniques trouvées.')).toBeVisible();
  await expect(
    page.getByText('2 médecins affichés au total dans les résultats.'),
  ).toBeVisible();
  await expect(page.locator('.publicClinic li')).toHaveCount(2);
  await search.fill('salima');
  await expect(page.getByText('1 clinique trouvée.')).toBeVisible();
  await expect(
    page.getByText('1 médecin affiché au total dans les résultats.'),
  ).toBeVisible();
  await expect(page.locator('.publicClinic li')).toHaveCount(1);
  await search.fill('sans medecin');
  await expect(page.getByText('1 clinique trouvée.')).toBeVisible();
  await expect(
    page.getByText('0 médecins affichés au total dans les résultats.'),
  ).toBeVisible();
  await expect(page.locator('.publicClinic li')).toHaveCount(0);
  await search.fill('etoile');
  await expect(
    page.getByText('3 médecins affichés au total dans les résultats.'),
  ).toBeVisible();
  await expect(page.locator('.publicClinic li')).toHaveCount(3);

  await page
    .getByRole('combobox', { name: 'Langue proposée par la clinique' })
    .selectOption('ar');
  await expect(
    page.getByText('3 médecins affichés au total dans les résultats.'),
  ).toBeVisible();
  await search.fill('introuvable');
  await expect(
    page.getByText('0 médecins affichés au total dans les résultats.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Effacer tous les filtres' }).click();
  await expect(total).toHaveCount(0);
  await page
    .getByRole('checkbox', {
      name: 'Cliniques avec médecins affichés uniquement',
    })
    .check();
  await expect(
    page.getByText('4 médecins affichés au total dans les résultats.'),
  ).toBeVisible();
  const language = page.getByRole('combobox', {
    name: 'Langue proposée par la clinique',
  });
  await language.selectOption('ar');
  await expect(page.getByText('1 clinique trouvée.')).toBeVisible();
  await expect(
    page.getByText('3 médecins affichés au total dans les résultats.'),
  ).toBeVisible();
  await expect(page.locator('.publicClinic')).toHaveCount(1);
  await expect(
    page.locator('.publicClinic').getByText('3 médecins affichés'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Effacer tous les filtres' }).click();
  await expect(language).toHaveValue('all');
  await expect(
    page.getByRole('checkbox', {
      name: 'Cliniques avec médecins affichés uniquement',
    }),
  ).not.toBeChecked();
  await expect(total).toHaveCount(0);
  const body = await page.locator('main').innerText();
  expect(body).not.toContain('private-total-tenant');
  expect(body).not.toContain('private-total-doctor');
});

test('Arabic RTL public result doctor total follows visible vowel-insensitive matches', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, [
    {
      name: 'عيادة الورد',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'د. مَرْيَم' }, { displayName: 'د. سارة' }],
    },
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
  const search = page.getByRole('searchbox', { name: 'ابحث عن عيادة أو طبيب' });
  await search.fill('مريم');
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.getByText('نتائج البحث: 2 عيادة.')).toBeVisible();
  await expect(
    page.getByText('إجمالي الأطباء المعروضين في النتائج: 2.'),
  ).toBeVisible();
  await expect(page.locator('.publicClinic li')).toHaveCount(2);
  await search.fill('الورد');
  await expect(
    page.getByText('إجمالي الأطباء المعروضين في النتائج: 2.'),
  ).toBeVisible();
  await expect(page.locator('.publicClinic li')).toHaveCount(2);
  await page.getByRole('button', { name: 'مسح جميع عوامل التصفية' }).click();
  await expect(
    page.getByText(/إجمالي الأطباء المعروضين في النتائج:/),
  ).toHaveCount(0);
});
test('Escape clears only focused search and preserves language, listed-doctor and sort filters', async ({
  page,
}) => {
  await mockDirectory(page, [
    {
      name: 'Clinique Étoile',
      defaultLocale: 'fr',
      enabledLocales: ['fr', 'ar'],
      tenantKey: 'private-escape-tenant',
      doctors: [{ displayName: 'Dr. Salima', id: 'private-escape-doctor' }],
    },
    {
      name: 'Cabinet du Centre',
      defaultLocale: 'fr',
      enabledLocales: ['fr'],
      doctors: [{ displayName: 'Dr. Paul' }],
    },
    {
      name: 'عيادة الورد',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'د. مَرْيَم' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  const search = page.getByRole('searchbox', {
    name: 'Rechercher une clinique ou un médecin',
  });
  const language = page.getByRole('combobox', {
    name: 'Langue proposée par la clinique',
  });
  const listed = page.getByRole('checkbox', {
    name: 'Cliniques avec médecins affichés uniquement',
  });
  const sort = page.getByRole('combobox', {
    name: 'Trier les cliniques par nom',
  });
  await language.selectOption('ar');
  await listed.check();
  await sort.selectOption('ascending');
  await search.fill('introuvable');
  await expect(page.locator('.publicClinic')).toHaveCount(0);
  await expect(page.getByText('0 cliniques trouvées.')).toBeVisible();

  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(language).toHaveValue('ar');
  await expect(listed).toBeChecked();
  await expect(sort).toHaveValue('ascending');
  await expect(page.locator('.publicClinic h3')).toHaveText([
    'Clinique Étoile',
    'عيادة الورد',
  ]);
  await expect(page.getByText('2 cliniques trouvées.')).toBeVisible();
  await search.press('Escape');
  await expect(language).toHaveValue('ar');
  await expect(listed).toBeChecked();
  const body = await page.locator('main').innerText();
  expect(body).not.toContain('private-escape-tenant');
  expect(body).not.toContain('private-escape-doctor');
});

test('Arabic mobile Escape restores vowel-insensitive doctor results and keeps RTL', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, [
    {
      name: 'عيادة الورد',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'د. مَرْيَم' }, { displayName: 'د. سارة' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  const search = page.getByRole('searchbox', { name: 'ابحث عن عيادة أو طبيب' });
  await search.fill('مريم');
  await expect(page.locator('.publicClinic li')).toHaveCount(1);
  await expect(
    page.getByText('إجمالي الأطباء المعروضين في النتائج: 1.'),
  ).toBeVisible();
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.locator('.publicClinic li')).toHaveCount(2);
  await expect(page.getByText('د. مَرْيَم')).toBeVisible();
  await expect(page.getByText('د. سارة')).toBeVisible();
});

test('slash focuses French public search without changing selected filters or revealing private identifiers', async ({
  page,
}) => {
  await mockDirectory(page, [
    {
      name: 'Clinique Étoile',
      defaultLocale: 'fr',
      enabledLocales: ['fr', 'ar'],
      tenantKey: 'private-shortcut-tenant',
      doctors: [{ displayName: 'Dr. Salima', id: 'private-shortcut-doctor' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  const search = page.getByRole('searchbox', {
    name: 'Rechercher une clinique ou un médecin',
  });
  await expect(search).toHaveAttribute(
    'aria-describedby',
    'publicClinicSearchShortcutHint',
  );
  await expect(
    page.getByText('Appuyez sur / pour accéder à la recherche.'),
  ).toBeVisible();
  const language = page.getByRole('combobox', {
    name: 'Langue proposée par la clinique',
  });
  const listed = page.getByRole('checkbox', {
    name: 'Cliniques avec médecins affichés uniquement',
  });
  const sort = page.getByRole('combobox', {
    name: 'Trier les cliniques par nom',
  });
  await language.selectOption('ar');
  await listed.check();
  await sort.selectOption('descending');
  await page.getByRole('button', { name: 'Actualiser' }).focus();
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await expect(language).toHaveValue('ar');
  await expect(listed).toBeChecked();
  await expect(sort).toHaveValue('descending');
  await search.fill('Salima');
  await search.press('/');
  await expect(search).toHaveValue('Salima/');
  await expect(search).toBeFocused();
  await language.focus();
  await page.keyboard.press('/');
  await expect(language).toBeFocused();
  await expect(language).toHaveValue('ar');
  const body = await page.locator('main').innerText();
  expect(body).not.toContain('private-shortcut-tenant');
  expect(body).not.toContain('private-shortcut-doctor');
});

test('slash focuses Arabic RTL public search from noneditable control on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDirectory(page, [
    {
      name: 'عيادة الورد',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      doctors: [{ displayName: 'د. مَرْيَم' }],
    },
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.getByText('اضغط / للانتقال إلى البحث.')).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'ابحث عن عيادة أو طبيب' });
  await page.getByRole('button', { name: 'العربية' }).focus();
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await search.fill('مريم');
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.getByText('د. مَرْيَم')).toBeVisible();
  await expect(page.locator('.publicClinic li')).toHaveCount(1);
  await search.press('/');
  await expect(search).toHaveValue('مريم/');
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
});
