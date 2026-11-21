import type { Page, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';
// All staff API calls are mocked with page.route; no server session is needed.
const clinicId = '20000000-0000-4000-8000-000000000001';
const base = `/api/clinics/${clinicId}`;

type Call = { method: string; path: string; body: unknown };

const copy = {
  fr: {
    title: 'Paramètres de la clinique',
    adminOnly: 'Réservé aux administrateurs.',
    loadError: 'Impossible de charger les paramètres.',
    name: 'Nom de la clinique',
    wilaya: 'Wilaya',
    commune: 'Commune',
    languages: 'Langues proposées',
    defaultLanguage: 'Langue par défaut',
    save: 'Enregistrer',
    saved: 'Modifications enregistrées.',
    unchanged: 'Aucune modification à enregistrer.',
    nameRequired: 'Indiquez le nom de la clinique.',
    arabic: 'Arabe',
    french: 'Français',
    closureDate: 'Date de fermeture',
    closureAdd: 'Ajouter',
    closureRemove: 'Retirer',
    closureAdded: 'Jour de fermeture ajouté.',
    closureRemoved: 'Jour de fermeture retiré.',
    closureConflict:
      'Des sessions existent déjà ce jour-là : annulez-les depuis l’accueil avant de fermer.',
  },
  ar: {
    title: 'إعدادات العيادة',
    adminOnly: 'مخصّص لمسؤولي العيادة.',
    loadError: 'تعذّر تحميل الإعدادات.',
    name: 'اسم العيادة',
    wilaya: 'الولاية',
    commune: 'البلدية',
    languages: 'اللغات المعروضة',
    defaultLanguage: 'اللغة الافتراضية',
    save: 'حفظ',
    saved: 'تم حفظ التعديلات.',
    unchanged: 'لا توجد تعديلات للحفظ.',
    nameRequired: 'أدخل اسم العيادة.',
    arabic: 'العربية',
    french: 'الفرنسية',
    closureDate: 'تاريخ الإغلاق',
    closureAdd: 'إضافة',
    closureRemove: 'إزالة',
    closureAdded: 'تمت إضافة يوم الإغلاق.',
    closureRemoved: 'تمت إزالة يوم الإغلاق.',
    closureConflict:
      'توجد جلسات في هذا اليوم: ألغِها من الاستقبال قبل الإغلاق.',
  },
} as const;

const clinic = {
  name: 'Clinique El Amel',
  timezone: 'Africa/Algiers',
  defaultLocale: 'fr',
  enabledLocales: ['ar', 'fr'],
  wilayaCode: null,
  commune: null,
  addressLine: null,
};

async function setup(
  page: Page,
  opts: {
    probeStatus?: number;
    closures?: string[];
    closureAddStatus?: number;
  } = {},
) {
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: 'mocked-staff-session',
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  const calls: Call[] = [];
  let closures = [...(opts.closures ?? [])];
  const record = (route: Route, path: string) => {
    const req = route.request();
    calls.push({
      method: req.method(),
      path,
      body: req.postData() ? req.postDataJSON() : null,
    });
  };
  await page.route(`**${base}/memberships`, (route) =>
    opts.probeStatus && opts.probeStatus !== 200
      ? route.fulfill({ status: opts.probeStatus, json: {} })
      : route.fulfill({ json: { memberships: [] } }),
  );
  await page.route(`**${base}/consultation-types**`, (route) =>
    route.fulfill({ json: { consultationTypes: [] } }),
  );
  await page.route(`**${base}/closures**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(base, '');
    if (req.method() === 'GET') return route.fulfill({ json: { closures } });
    record(route, path);
    if (req.method() === 'POST') {
      if (opts.closureAddStatus && opts.closureAddStatus !== 200)
        return route.fulfill({ status: opts.closureAddStatus, json: {} });
      closures = [...closures, req.postDataJSON().closureDate];
    } else {
      closures = closures.filter((d) => !path.endsWith(`/${d}`));
    }
    return route.fulfill({ json: {} });
  });
  await page.route(
    (url) => url.pathname === base,
    (route) => {
      const req = route.request();
      if (req.method() === 'GET') return route.fulfill({ json: { clinic } });
      record(route, '');
      return route.fulfill({
        json: { clinic: { ...clinic, ...req.postDataJSON() } },
      });
    },
  );
  return { calls };
}

const profileCalls = (calls: Call[]) =>
  calls.filter((c) => c.method === 'PATCH');

for (const locale of ['fr', 'ar'] as const) {
  const t = copy[locale];
  const url = `/operations/${clinicId}/settings/clinic?locale=${locale}`;

  test.describe(`clinic settings ${locale}`, () => {
    test('renders the profile form with the right direction', async ({
      page,
    }) => {
      await setup(page);
      await page.goto(url);
      await expect(page.getByRole('heading', { name: t.title })).toBeVisible();
      await expect(page.getByLabel(t.name)).toHaveValue(clinic.name);
      await expect(page.locator('html')).toHaveAttribute(
        'dir',
        locale === 'ar' ? 'rtl' : 'ltr',
      );
      // No wilaya: the location detail fields are locked.
      await expect(page.getByLabel(t.commune)).toBeDisabled();
    });

    test('a non-admin sees no form and the API is never written', async ({
      page,
    }) => {
      const { calls } = await setup(page, { probeStatus: 403 });
      await page.goto(url);
      await expect(
        page.getByRole('alert').filter({ hasText: t.adminOnly }),
      ).toHaveCount(1);
      await expect(page.getByLabel(t.name)).toHaveCount(0);
      await expect(page.getByRole('button', { name: t.save })).toHaveCount(0);
      expect(calls).toEqual([]);
    });

    test('a failing admin probe shows the load error, not the form', async ({
      page,
    }) => {
      await setup(page, { probeStatus: 500 });
      await page.goto(url);
      await expect(
        page.getByRole('alert').filter({ hasText: t.loadError }),
      ).toHaveCount(1);
      await expect(page.getByLabel(t.name)).toHaveCount(0);
    });

    test('saving sends only the changed field', async ({ page }) => {
      const { calls } = await setup(page);
      await page.goto(url);
      await page.getByLabel(t.name).fill('Clinique Nour');
      await page.getByRole('button', { name: t.save }).click();
      await expect(
        page.getByRole('status').filter({ hasText: t.saved }),
      ).toBeVisible();
      expect(profileCalls(calls)).toEqual([
        { method: 'PATCH', path: '', body: { name: 'Clinique Nour' } },
      ]);
    });

    test('an unchanged or empty form is refused locally with focus on the summary', async ({
      page,
    }) => {
      const { calls } = await setup(page);
      await page.goto(url);
      await page.getByRole('button', { name: t.save }).click();
      const alert = page.getByRole('alert').filter({ hasText: t.unchanged });
      await expect(alert).toBeFocused();

      await page.getByLabel(t.name).fill('   ');
      await page.getByRole('button', { name: t.save }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: t.nameRequired }),
      ).toBeFocused();
      expect(profileCalls(calls)).toEqual([]);
    });

    test('a wilaya unlocks the location and the whole location travels', async ({
      page,
    }) => {
      const { calls } = await setup(page);
      await page.goto(url);
      await page.getByLabel(t.wilaya, { exact: true }).selectOption('16');
      await page.getByLabel(t.commune).fill('Bab El Oued');
      await page.getByRole('button', { name: t.save }).click();
      await expect(
        page.getByRole('status').filter({ hasText: t.saved }),
      ).toBeVisible();
      expect(profileCalls(calls)[0]?.body).toEqual({
        wilayaCode: '16',
        commune: 'Bab El Oued',
        addressLine: null,
      });
    });

    test('unchecking a language keeps the default among the offered ones', async ({
      page,
    }) => {
      const { calls } = await setup(page);
      await page.goto(url);
      await page.getByLabel(t.french, { exact: true }).first().uncheck();
      await expect(page.getByLabel(t.defaultLanguage)).toHaveValue('ar');
      await page.getByRole('button', { name: t.save }).click();
      await expect(
        page.getByRole('status').filter({ hasText: t.saved }),
      ).toBeVisible();
      expect(profileCalls(calls)[0]?.body).toEqual({
        defaultLocale: 'ar',
        enabledLocales: ['ar'],
      });
    });

    test('closure days: add, conflict, remove', async ({ page }) => {
      const { calls } = await setup(page, { closures: ['2026-12-25'] });
      await page.goto(url);
      await expect(
        page.getByRole('button', { name: t.closureRemove }),
      ).toHaveCount(1);

      await page.getByLabel(t.closureDate).fill('2027-01-01');
      await page
        .getByRole('button', { name: t.closureAdd, exact: true })
        .click();
      await expect(
        page.getByRole('status').filter({ hasText: t.closureAdded }),
      ).toBeVisible();
      // The list is re-read after the commit.
      await expect(
        page.getByRole('button', { name: t.closureRemove }),
      ).toHaveCount(2);
      expect(calls.at(-1)).toEqual({
        method: 'POST',
        path: '/closures',
        body: { closureDate: '2027-01-01' },
      });

      await page.getByRole('button', { name: t.closureRemove }).first().click();
      await expect(
        page.getByRole('status').filter({ hasText: t.closureRemoved }),
      ).toBeVisible();
      expect(calls.at(-1)).toEqual({
        method: 'DELETE',
        path: '/closures/2026-12-25',
        body: null,
      });
    });

    test('a closure on a day with sessions shows the conflict message', async ({
      page,
    }) => {
      await setup(page, { closureAddStatus: 409 });
      await page.goto(url);
      await page.getByLabel(t.closureDate).fill('2027-01-01');
      await page
        .getByRole('button', { name: t.closureAdd, exact: true })
        .click();
      await expect(
        page.getByRole('alert').filter({ hasText: t.closureConflict }),
      ).toHaveCount(1);
    });
  });
}
