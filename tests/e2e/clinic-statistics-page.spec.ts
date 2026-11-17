import { expect, test } from '@playwright/test';

const clinicId = '30000000-0000-4000-8000-000000000001';
const STATS_URL = `**/api/clinics/${clinicId}/statistics**`;

const body = {
  from: '2026-11-01',
  to: '2026-11-07',
  totals: {
    sessions: 4,
    completed: 12,
    noShow: 2,
    cancelled: 1,
    openedSessions: 4,
    lateStarts: 1,
  },
  doctors: [
    {
      doctorId: '30000000-0000-4000-8000-0000000000d1',
      doctorName: 'Dr Amine Benali',
      sessions: 4,
      completed: 12,
      noShow: 2,
      cancelled: 1,
      averageConsultationSeconds: 900,
      openedSessions: 4,
      lateStarts: 1,
      averageStartDelayMinutes: null,
    },
  ],
  delayTrend: [{ date: '2026-11-01', sessions: 4, opened: 4, lateStarts: 1 }],
};

test.beforeEach(async ({ page }) => {
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: 'mocked-staff-session',
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
});

test('French view shows totals, per-doctor rows and withheld averages', async ({
  page,
}) => {
  let requested = '';
  await page.route(STATS_URL, async (route) => {
    requested = route.request().url();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  await page.goto(`/operations/${clinicId}/statistics?locale=fr`);
  await expect(
    page.getByRole('heading', { name: 'Statistiques de la clinique' }),
  ).toBeVisible();
  const row = page.getByRole('row', { name: /Dr Amine Benali/ });
  await expect(row.getByRole('cell').nth(4)).toHaveText('15');
  await expect(row.getByRole('cell').nth(6)).toHaveText('Non affiché');
  expect(requested).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
});

test('Arabic view is RTL and an empty window says so', async ({ page }) => {
  await page.route(STATS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...body,
        totals: { ...body.totals, sessions: 0 },
        doctors: [],
        delayTrend: [],
      }),
    });
  });
  await page.goto(`/operations/${clinicId}/statistics?locale=ar`);
  await expect(page.locator('main')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByText('لا توجد جلسات في هذه الفترة.')).toBeVisible();
});

test('a rejected request shows an error and an over-long window blocks submit', async ({
  page,
}) => {
  await page.route(STATS_URL, async (route) => {
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: '{}',
    });
  });
  await page.goto(`/operations/${clinicId}/statistics?locale=fr`);
  await expect(page.getByText('Impossible de charger')).toBeVisible();
  await page.getByLabel('Du').fill('2026-01-01');
  await expect(page.getByRole('button', { name: 'Afficher' })).toBeDisabled();
  await expect(page.getByText(/31 jours/)).toBeVisible();
});
