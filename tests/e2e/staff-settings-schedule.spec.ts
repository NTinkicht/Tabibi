import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
// All staff API calls are mocked with page.route; no server session is needed.
const clinicId = '20000000-0000-4000-8000-000000000001';
const base = `/api/clinics/${clinicId}`;
const doctorId = '30000000-0000-4000-8000-000000000001';

type Call = { method: string; path: string; body: unknown };

const copy = {
  fr: {
    manage: 'Gérer',
    addRange: 'Ajouter une plage',
    start: 'Début',
    end: 'Fin',
    saveRange: 'Enregistrer la plage',
    rangeAdded: 'Plage ajoutée.',
    overlap: 'Cette plage chevauche une plage existante.',
    generateRun: 'Générer',
    generateStart: 'Date de début',
    generatePeriod: 'Période',
    weeks8: '8 semaines',
    generateNeedsDate: 'Choisissez une date de début.',
    absenceDate: 'Date',
    absenceAdd: 'Ajouter',
    absenceAdded: 'Absence ajoutée.',
    absenceRemove: 'Retirer',
    absenceRemoved: 'Absence retirée.',
    absenceNeedsDate: 'Choisissez une date.',
    absenceConflict:
      'Des sessions existent déjà ce jour-là : annulez-les depuis l’accueil avant de déclarer l’absence.',
  },
  ar: {
    manage: 'إدارة',
    addRange: 'إضافة فترة',
    start: 'البداية',
    end: 'النهاية',
    saveRange: 'حفظ الفترة',
    rangeAdded: 'تمت إضافة الفترة.',
    overlap: 'تتداخل هذه الفترة مع فترة موجودة.',
    generateRun: 'إنشاء',
    generateStart: 'تاريخ البداية',
    generatePeriod: 'المدة',
    weeks8: '8 أسابيع',
    generateNeedsDate: 'اختر تاريخ البداية.',
    absenceDate: 'التاريخ',
    absenceAdd: 'إضافة',
    absenceAdded: 'تمت إضافة الغياب.',
    absenceRemove: 'إزالة',
    absenceRemoved: 'تمت إزالة الغياب.',
    absenceNeedsDate: 'اختر تاريخًا.',
    absenceConflict:
      'توجد جلسات في ذلك اليوم: ألغها من الاستقبال قبل تسجيل الغياب.',
  },
} as const;

async function setup(
  page: Page,
  opts: { templateWriteStatus?: number; absenceWriteStatus?: number } = {},
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
  let absences = ['2026-12-25'];
  const record = (method: string, path: string, body: unknown) =>
    calls.push({ method, path, body });
  await page.route(`**${base}/memberships`, (route) =>
    route.fulfill({
      json: {
        memberships: [
          { userId: 'u-1', displayName: 'Dr Amine', identifier: 'amine' },
        ],
      },
    }),
  );
  await page.route(
    (url) => url.pathname === `${base}/doctors`,
    (route) =>
      route.fulfill({
        json: {
          doctors: [
            {
              id: doctorId,
              userId: 'u-1',
              displayName: 'Dr Amine',
              specialtyCodes: ['pediatrics'],
            },
          ],
        },
      }),
  );
  await page.route(`**${base}/schedule-templates**`, (route) => {
    const req = route.request();
    if (req.method() === 'GET')
      return route.fulfill({ json: { templates: [] } });
    record(req.method(), '/schedule-templates', req.postDataJSON());
    return route.fulfill({
      status: opts.templateWriteStatus ?? 201,
      json: {},
    });
  });
  await page.route(`**${base}/schedule-generations`, (route) => {
    record('POST', '/schedule-generations', route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { generated: 3 } });
  });
  await page.route(`**${base}/doctors/${doctorId}/absences**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(base, '');
    if (req.method() === 'GET') return route.fulfill({ json: { absences } });
    record(req.method(), path, req.postData() ? req.postDataJSON() : null);
    if (opts.absenceWriteStatus && opts.absenceWriteStatus !== 200)
      return route.fulfill({ status: opts.absenceWriteStatus, json: {} });
    if (req.method() === 'POST')
      absences = [...absences, req.postDataJSON().absenceDate];
    else absences = absences.filter((d) => !path.endsWith(`/${d}`));
    return route.fulfill({ json: {} });
  });
  return { calls };
}

for (const locale of ['fr', 'ar'] as const) {
  const t = copy[locale];
  const url = `/operations/${clinicId}/settings/doctors?locale=${locale}`;

  test.describe(`doctor schedule settings ${locale}`, () => {
    test('a weekly range needs a valid span and sends the next occurrence index', async ({
      page,
    }) => {
      const { calls } = await setup(page);
      await page.goto(url);
      await page.getByRole('button', { name: t.manage }).click();
      await page.getByRole('button', { name: t.addRange }).first().click();
      await page.locator('#cs-start-0').fill('14:00');
      await page.locator('#cs-end-0').fill('09:00');
      await page.getByRole('button', { name: t.saveRange }).click();
      await expect(
        page
          .locator('section[aria-labelledby="cs-week-title"]')
          .getByRole('alert'),
      ).toBeFocused();
      expect(calls).toEqual([]);

      await page.locator('#cs-start-0').fill('09:00');
      await page.locator('#cs-end-0').fill('12:00');
      await page.getByRole('button', { name: t.saveRange }).click();
      await expect(
        page.getByRole('status').filter({ hasText: t.rangeAdded }),
      ).toBeVisible();
      expect(calls).toEqual([
        {
          method: 'POST',
          path: '/schedule-templates',
          body: {
            doctorId,
            weekday: 0,
            localStartTime: '09:00',
            localEndTime: '12:00',
            occurrenceIndex: 0,
          },
        },
      ]);
    });

    test('an overlapping range shows the overlap message', async ({ page }) => {
      await setup(page, { templateWriteStatus: 409 });
      await page.goto(url);
      await page.getByRole('button', { name: t.manage }).click();
      await page.getByRole('button', { name: t.addRange }).first().click();
      await page.locator('#cs-start-0').fill('09:00');
      await page.locator('#cs-end-0').fill('12:00');
      await page.getByRole('button', { name: t.saveRange }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: t.overlap }),
      ).toBeFocused();
    });

    test('generation sends the 8-week window and reports the committed count', async ({
      page,
    }) => {
      const { calls } = await setup(page);
      await page.goto(url);
      await page.getByRole('button', { name: t.manage }).click();
      await page.getByLabel(t.generateStart).fill('');
      await page.getByRole('button', { name: t.generateRun }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: t.generateNeedsDate }),
      ).toBeFocused();
      expect(calls).toEqual([]);

      await page.getByLabel(t.generateStart).fill('2027-01-04');
      await page.getByLabel(t.generatePeriod).selectOption({ label: t.weeks8 });
      await page.getByRole('button', { name: t.generateRun }).click();
      await expect(
        page.getByRole('status').filter({ hasText: /3/ }),
      ).toBeVisible();
      expect(calls).toEqual([
        {
          method: 'POST',
          path: '/schedule-generations',
          body: { doctorId, startDate: '2027-01-04', daysAhead: 56 },
        },
      ]);
    });

    test('absences: need a date, add, conflict, remove', async ({ page }) => {
      const { calls } = await setup(page);
      await page.goto(url);
      await page.getByRole('button', { name: t.manage }).click();
      const section = page.locator(
        'section[aria-labelledby="cs-absences-title"]',
      );
      await expect(
        section.getByRole('button', { name: t.absenceRemove }),
      ).toHaveCount(1);

      await section.getByRole('button', { name: t.absenceAdd }).click();
      await expect(
        section.getByRole('alert').filter({ hasText: t.absenceNeedsDate }),
      ).toBeFocused();
      expect(calls).toEqual([]);

      await section.locator('input[type=date]').fill('2027-01-01');
      await section.getByRole('button', { name: t.absenceAdd }).click();
      await expect(
        section.getByRole('status').filter({ hasText: t.absenceAdded }),
      ).toBeVisible();
      await expect(
        section.getByRole('button', { name: t.absenceRemove }),
      ).toHaveCount(2);
      expect(calls.at(-1)).toEqual({
        method: 'POST',
        path: `/doctors/${doctorId}/absences`,
        body: { absenceDate: '2027-01-01' },
      });

      await section
        .getByRole('button', { name: t.absenceRemove })
        .first()
        .click();
      await expect(
        section.getByRole('status').filter({ hasText: t.absenceRemoved }),
      ).toBeVisible();
      expect(calls.at(-1)).toEqual({
        method: 'DELETE',
        path: `/doctors/${doctorId}/absences/2026-12-25`,
        body: null,
      });
    });

    test('an absence on a day with sessions shows the conflict message', async ({
      page,
    }) => {
      await setup(page, { absenceWriteStatus: 409 });
      await page.goto(url);
      await page.getByRole('button', { name: t.manage }).click();
      const section = page.locator(
        'section[aria-labelledby="cs-absences-title"]',
      );
      await section.locator('input[type=date]').fill('2027-01-01');
      await section.getByRole('button', { name: t.absenceAdd }).click();
      await expect(
        section.getByRole('alert').filter({ hasText: t.absenceConflict }),
      ).toBeFocused();
    });
  });
}
