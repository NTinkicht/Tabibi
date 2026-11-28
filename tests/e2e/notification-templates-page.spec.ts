import { expect, test } from '@playwright/test';

const clinicId = '30000000-0000-4000-8000-000000000001';
const API = `**/api/clinics/${clinicId}/notification-templates`;

const body = {
  templates: [
    {
      templateId: 'session_delayed.v1',
      variables: ['delayMinutes'],
      previews: {
        fr: {
          direction: 'ltr',
          title: 'Séance retardée',
          body: 'Retard de 15 minutes.',
        },
        ar: { direction: 'rtl', title: 'تأخر الجلسة', body: 'تأخر 15 دقيقة.' },
      },
    },
  ],
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

test('French view shows exact FR and AR wording and the variable names', async ({
  page,
}) => {
  await page.route(API, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
  await page.goto(`/operations/${clinicId}/notifications/templates?locale=fr`);
  await expect(
    page.getByRole('heading', { name: 'Modèles de notification' }),
  ).toBeVisible();
  await expect(page.getByText('Retard de 15 minutes.')).toBeVisible();
  await expect(page.getByText('تأخر 15 دقيقة.')).toBeVisible();
  await expect(page.getByText('delayMinutes')).toBeVisible();
  await expect(page.locator('[lang="ar"][dir="rtl"]').first()).toBeVisible();
});

test('Arabic view is RTL and an empty catalogue says so', async ({ page }) => {
  await page.route(API, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ templates: [] }),
    }),
  );
  await page.goto(`/operations/${clinicId}/notifications/templates?locale=ar`);
  await expect(page.locator('main')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByText('لا توجد نماذج متاحة.')).toBeVisible();
});

test('a rejected request shows an error and retry recovers', async ({
  page,
}) => {
  let calls = 0;
  await page.route(API, (route) => {
    calls += 1;
    if (calls === 1)
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: '{}',
      });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  await page.goto(`/operations/${clinicId}/notifications/templates?locale=fr`);
  await expect(page.locator('main').getByRole('alert')).toContainText(
    'Impossible de charger',
  );
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(page.getByText('Retard de 15 minutes.')).toBeVisible();
  expect(calls).toBe(2);
});
