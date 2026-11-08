import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

// docs/design/reception-home.md "Acceptance" (TAB-UI-14 slice 2): sign-in each
// error state, notifications tables and empty states, fr/ar at 1440 and
// 1024 px, keyboard-only use and no serious/critical axe violations.
const axeSource = require.resolve('axe-core/axe.min.js');
const clinicId = '30000000-0000-4000-8000-0000000000a1';

async function seriousViolations(page: Page) {
  await page.addScriptTag({ path: axeSource });
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            ctx: Document,
            opts: unknown,
          ) => Promise<{
            violations: Array<{ id: string; impact: string | null }>;
          }>;
        };
      }
    ).axe;
    const result = await axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      },
    });
    return result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id);
  });
}

const viewports = [
  { name: 1440, width: 1440, height: 900 },
  { name: 1024, width: 1024, height: 768 },
];

const errorCases = [
  { status: 401, key: 'failed', fr: 'Identifiant ou mot de passe incorrect' },
  { status: 429, key: 'rateLimited', fr: 'Trop de tentatives' },
  { status: 503, key: 'unavailable', fr: 'Service indisponible' },
] as const;

for (const vp of viewports) {
  for (const locale of ['fr', 'ar'] as const) {
    test(`sign-in ${locale} ${vp.name}px: card, help line, axe`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`/staff/sign-in?locale=${locale}`);
      const card = page.locator('.si-card');
      const box = await card.boundingBox();
      expect(box?.width).toBeLessThanOrEqual(420);
      await expect(page.locator('.si-help')).toBeVisible();
      await expect(page.locator('.si-submit')).toHaveCSS('min-height', '52px');
      expect(await seriousViolations(page)).toEqual([]);
    });
  }
}

for (const c of errorCases) {
  test(`sign-in error state ${c.key}: alert, focus, invalid outline only for bad credentials`, async ({
    page,
  }) => {
    await page.route('**/api/staff/session', (route) =>
      route.fulfill({
        status: c.status,
        contentType: 'application/json',
        body: '{}',
      }),
    );
    await page.goto('/staff/sign-in?locale=fr');
    await page.locator('#staff-subject').fill('someone');
    await page.locator('#staff-password').fill('whatever-password');
    await page.getByRole('button', { name: 'Se connecter' }).click();
    const alert = page.getByTestId('sign-in-error');
    await expect(alert).toContainText(c.fr);
    await expect(alert).toBeFocused();
    if (c.key === 'failed')
      await expect(page.locator('#staff-subject')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
    else
      await expect(page.locator('#staff-subject')).not.toHaveAttribute(
        'aria-invalid',
        /.*/,
      );
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('sign-in error state noClinic (success without memberships)', async ({
  page,
}) => {
  await page.route('**/api/staff/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ memberships: [] }),
    }),
  );
  await page.goto('/staff/sign-in?locale=fr');
  await page.locator('#staff-subject').fill('someone');
  await page.locator('#staff-password').fill('whatever-password');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByTestId('sign-in-error')).toContainText(
    'Aucune clinique',
  );
});

async function mockNotifications(
  page: Page,
  deadLetters: unknown[],
  failures: unknown[],
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
  await page.route(
    `**/api/clinics/${clinicId}/notifications/dead-letters**`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deadLetters }),
      }),
  );
  await page.route(
    `**/api/clinics/${clinicId}/notifications/guest-link-failures**`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ failures }),
      }),
  );
}

for (const vp of viewports) {
  for (const locale of ['fr', 'ar'] as const) {
    test(`notifications ${locale} ${vp.name}px: both tables with column headers, axe`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mockNotifications(
        page,
        [
          {
            intentId: 'x',
            eventKey: 'patient_called',
            queueLabel: 'A-041',
            outcomeCode: null,
            attemptCount: 3,
            maxAttempts: 5,
            outcomeAt: '2026-09-13T10:00:00.000Z',
          },
        ],
        [
          {
            intentId: 'y',
            intent: 'resend',
            state: 'dead_letter',
            queueLabel: 'B-007',
            attempts: 4,
            outcomeAt: '2026-09-13T11:00:00.000Z',
          },
        ],
      );
      await page.goto(`/operations/${clinicId}/notifications?locale=${locale}`);
      await expect(page.getByRole('table')).toHaveCount(2);
      await expect(page.locator('th[scope="col"]')).toHaveCount(10);
      await expect(page.locator('td bdi').first()).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });
  }
}

test('notifications: empty states for both sections and keyboard reach the refresh button', async ({
  page,
}) => {
  await mockNotifications(page, [], []);
  await page.goto(`/operations/${clinicId}/notifications?locale=fr`);
  await expect(
    page.getByText('Aucune notification en échec de livraison.'),
  ).toBeVisible();
  await expect(
    page.getByText('Aucun lien de suivi en échec de livraison.'),
  ).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  const refresh = page.getByRole('button', { name: 'Actualiser' });
  for (
    let i = 0;
    i < 6 && !(await refresh.evaluate((el) => el === document.activeElement));
    i++
  )
    await page.keyboard.press('Tab');
  await expect(refresh).toBeFocused();
});
