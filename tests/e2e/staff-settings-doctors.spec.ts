import type { Page, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';
// All staff API calls are mocked with page.route; no server session is needed.
const clinicId = '20000000-0000-4000-8000-000000000001';
const base = `/api/clinics/${clinicId}`;
const doctorId = '30000000-0000-4000-8000-000000000001';
const doctorUser = '40000000-0000-4000-8000-000000000001';
const freeUser = '40000000-0000-4000-8000-000000000002';

type Call = { method: string; path: string; body: unknown };

const copy = {
  fr: {
    adminOnly: 'Réservé aux administrateurs.',
    loadError: 'Impossible de charger les paramètres.',
    actionFailed: 'Action impossible. Réessayez.',
    doctorsTitle: 'Médecins',
    manage: 'Gérer',
    memberLabel: 'Membre du personnel',
    publicName: 'Nom affiché aux patients',
    addDoctor: 'Ajouter le médecin',
    doctorAdded: 'Médecin ajouté.',
    memberRequired: 'Choisissez un membre du personnel.',
    nameInvalid: 'Saisissez un nom affiché de 1 à 120 caractères.',
    specialtiesSave: 'Enregistrer les spécialités',
    specialtiesSaved: 'Spécialités enregistrées.',
    specialtiesNeedOne: 'Choisissez de 1 à 3 spécialités.',
    pediatrics: 'Pédiatrie',
    cardiology: 'Cardiologie',
    generalMedicine: 'Médecine générale',
  },
  ar: {
    adminOnly: 'مخصّص لمسؤولي العيادة.',
    loadError: 'تعذّر تحميل الإعدادات.',
    actionFailed: 'تعذّر تنفيذ الإجراء. أعد المحاولة.',
    doctorsTitle: 'الأطباء',
    manage: 'إدارة',
    memberLabel: 'عضو الطاقم',
    publicName: 'الاسم الظاهر للمرضى',
    addDoctor: 'إضافة الطبيب',
    doctorAdded: 'تمت إضافة الطبيب.',
    memberRequired: 'اختر عضوًا من الطاقم.',
    nameInvalid: 'أدخل اسمًا ظاهرًا من 1 إلى 120 حرفًا.',
    specialtiesSave: 'حفظ التخصصات',
    specialtiesSaved: 'تم حفظ التخصصات.',
    specialtiesNeedOne: 'اختر من 1 إلى 3 تخصصات.',
    pediatrics: 'طب الأطفال',
    cardiology: 'أمراض القلب',
    generalMedicine: 'الطب العام',
  },
} as const;

const members = [
  { userId: doctorUser, displayName: 'Dr Amine', identifier: 'amine' },
  { userId: freeUser, displayName: 'Sara Reception', identifier: 'sara' },
];

async function setup(
  page: Page,
  opts: { probeStatus?: number; writeStatus?: number } = {},
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
  let doctors = [
    {
      id: doctorId,
      userId: doctorUser,
      displayName: 'Dr Amine',
      specialtyCodes: ['pediatrics'],
    },
  ];
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
      : route.fulfill({ json: { memberships: members } }),
  );
  await page.route(`**${base}/schedule-templates**`, (route) =>
    route.fulfill({ json: { templates: [] } }),
  );
  await page.route(`**${base}/doctors/${doctorId}/absences**`, (route) =>
    route.fulfill({ json: { absences: [] } }),
  );
  await page.route(`**${base}/doctors/${doctorId}`, (route) => {
    const req = route.request();
    record(route, `/doctors/${doctorId}`);
    if (opts.writeStatus && opts.writeStatus !== 200)
      return route.fulfill({ status: opts.writeStatus, json: {} });
    doctors = doctors.map((d) => ({
      ...d,
      specialtyCodes: req.postDataJSON().specialtyCodes,
    }));
    return route.fulfill({ json: {} });
  });
  await page.route(
    (url) => url.pathname === `${base}/doctors`,
    (route) => {
      const req = route.request();
      if (req.method() === 'GET') return route.fulfill({ json: { doctors } });
      record(route, '/doctors');
      if (opts.writeStatus && opts.writeStatus !== 200)
        return route.fulfill({ status: opts.writeStatus, json: {} });
      const body = req.postDataJSON();
      doctors = [
        ...doctors,
        {
          id: '30000000-0000-4000-8000-000000000002',
          userId: body.userId,
          displayName: body.displayName,
          specialtyCodes: [],
        },
      ];
      return route.fulfill({ status: 201, json: {} });
    },
  );
  return { calls };
}

for (const locale of ['fr', 'ar'] as const) {
  const t = copy[locale];
  const url = `/operations/${clinicId}/settings/doctors?locale=${locale}`;

  test.describe(`doctors settings ${locale}`, () => {
    test('lists doctors with specialties and the right direction', async ({
      page,
    }) => {
      await setup(page);
      await page.goto(url);
      await expect(
        page.getByRole('heading', { name: t.doctorsTitle, exact: true }),
      ).toBeVisible();
      await expect(page.getByText('Dr Amine').first()).toBeVisible();
      await expect(page.getByText(t.pediatrics).first()).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute(
        'dir',
        locale === 'ar' ? 'rtl' : 'ltr',
      );
    });

    test('a non-admin sees the role message and nothing is written', async ({
      page,
    }) => {
      const { calls } = await setup(page, { probeStatus: 403 });
      await page.goto(url);
      await expect(
        page.getByRole('alert').filter({ hasText: t.adminOnly }),
      ).toHaveCount(1);
      await expect(page.getByLabel(t.memberLabel)).toHaveCount(0);
      await expect(page.getByRole('button', { name: t.manage })).toHaveCount(0);
      expect(calls).toEqual([]);
    });

    test('a failing probe shows the load error, not the page body', async ({
      page,
    }) => {
      await setup(page, { probeStatus: 500 });
      await page.goto(url);
      await expect(
        page.getByRole('alert').filter({ hasText: t.loadError }),
      ).toHaveCount(1);
      await expect(page.getByLabel(t.memberLabel)).toHaveCount(0);
    });

    test('only members who are not yet doctors can be added', async ({
      page,
    }) => {
      await setup(page);
      await page.goto(url);
      const options = page.getByLabel(t.memberLabel).locator('option');
      await expect(options).toHaveCount(2); // placeholder + one member
      await expect(options.nth(1)).toHaveText('Sara Reception (sara)');
    });

    test('adding a doctor validates locally, then sends the trimmed body', async ({
      page,
    }) => {
      const { calls } = await setup(page);
      await page.goto(url);
      await page.getByRole('button', { name: t.addDoctor }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: t.memberRequired }),
      ).toBeFocused();
      await page.getByLabel(t.memberLabel).selectOption(freeUser);
      await page.getByLabel(t.publicName).fill('   ');
      await page.getByRole('button', { name: t.addDoctor }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: t.nameInvalid }),
      ).toBeFocused();
      expect(calls).toEqual([]);

      await page.getByLabel(t.publicName).fill('  Dr Sara  ');
      await page.getByRole('button', { name: t.addDoctor }).click();
      await expect(
        page.getByRole('status').filter({ hasText: t.doctorAdded }),
      ).toBeVisible();
      expect(calls).toEqual([
        {
          method: 'POST',
          path: '/doctors',
          body: { userId: freeUser, displayName: 'Dr Sara' },
        },
      ]);
      // The committed list is re-read: the new doctor shows, no member is left.
      await expect(page.getByText('Dr Sara').first()).toBeVisible();
    });

    test('a failed add shows the generic error', async ({ page }) => {
      await setup(page, { writeStatus: 500 });
      await page.goto(url);
      await page.getByLabel(t.memberLabel).selectOption(freeUser);
      await page.getByLabel(t.publicName).fill('Dr Sara');
      await page.getByRole('button', { name: t.addDoctor }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: t.actionFailed }),
      ).toBeFocused();
    });

    test('specialties: need at least one, then PATCH the chosen codes', async ({
      page,
    }) => {
      const { calls } = await setup(page);
      await page.goto(url);
      await page.getByRole('button', { name: t.manage }).click();
      await page.getByLabel(t.pediatrics, { exact: true }).uncheck();
      await page.getByRole('button', { name: t.specialtiesSave }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: t.specialtiesNeedOne }),
      ).toBeFocused();
      expect(calls).toEqual([]);

      await page.getByLabel(t.cardiology, { exact: true }).check();
      await page.getByLabel(t.generalMedicine, { exact: true }).check();
      await page.getByRole('button', { name: t.specialtiesSave }).click();
      await expect(
        page.getByRole('status').filter({ hasText: t.specialtiesSaved }),
      ).toBeVisible();
      expect(calls).toEqual([
        {
          method: 'PATCH',
          path: `/doctors/${doctorId}`,
          body: { specialtyCodes: ['cardiology', 'general_medicine'] },
        },
      ]);
    });

    test('a fourth specialty cannot be ticked', async ({ page }) => {
      await setup(page);
      await page.goto(url);
      await page.getByRole('button', { name: t.manage }).click();
      await page.getByLabel(t.cardiology, { exact: true }).check();
      await page.getByLabel(t.generalMedicine, { exact: true }).check();
      const unchecked = page
        .getByRole('group')
        .locator('input[type=checkbox]:not(:checked)');
      await expect(unchecked.first()).toBeDisabled();
    });
  });
}
