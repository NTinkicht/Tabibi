import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

// docs/design/reception-home.md "Acceptance": fr/ar at 1440 and 1024 px, every
// status, counts line, empty day, undelivered banner, keyboard navigation and
// no serious/critical axe violations. Staff APIs are mocked with page.route.
const clinicId = '40000000-0000-4000-8000-000000000001';
const axeSource = require.resolve('axe-core/axe.min.js');

const zero = {
  waiting: 0,
  checkedIn: 0,
  called: 0,
  inConsultation: 0,
  completed: 0,
  noShow: 0,
  cancelled: 0,
};
function session(
  n: number,
  status: string,
  over: Record<string, unknown> = {},
) {
  return {
    id: `40000000-0000-4000-8000-00000000010${n}`,
    doctorId: `40000000-0000-4000-8000-00000000020${n}`,
    doctorDisplayName: `Dr Leila ${n}`,
    startsAt: '2026-09-08T08:00:00.000Z',
    endsAt: '2026-09-08T11:00:00.000Z',
    status,
    openedAt: null,
    closedAt: null,
    declaredDelayMinutes: null,
    delayVersion: 0,
    queueCounts: zero,
    ...over,
  };
}
const allStatuses = [
  session(1, 'planned'),
  session(2, 'open', {
    openedAt: '2026-09-08T08:02:00.000Z',
    declaredDelayMinutes: 15,
    queueCounts: { ...zero, checkedIn: 4, waiting: 2, called: 1, completed: 6 },
  }),
  session(3, 'paused', { openedAt: '2026-09-08T08:02:00.000Z' }),
  session(4, 'closed', {
    openedAt: '2026-09-08T08:02:00.000Z',
    closedAt: '2026-09-08T11:01:00.000Z',
  }),
  session(5, 'cancelled'),
];

async function mockHome(
  page: Page,
  sessions: unknown[],
  deadLetters = 0,
  guestFailures: number | 'fail' = 0,
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
  await page.route(`**/api/clinics/${clinicId}/sessions**`, (route) =>
    route.fulfill({ json: { sessions, timezone: 'Africa/Algiers' } }),
  );
  await page.route(
    `**/api/clinics/${clinicId}/notifications/dead-letters**`,
    (route) =>
      route.fulfill({
        json: { deadLetters: Array.from({ length: deadLetters }, () => ({})) },
      }),
  );
  await page.route(
    `**/api/clinics/${clinicId}/notifications/guest-link-failures**`,
    (route) =>
      guestFailures === 'fail'
        ? route.fulfill({ status: 500, json: {} })
        : route.fulfill({
            json: {
              failures: Array.from({ length: guestFailures }, () => ({})),
            },
          }),
  );
}

const viewports = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
];
const locales = [
  { locale: 'fr', dir: 'ltr' },
  { locale: 'ar', dir: 'rtl' },
] as const;

for (const { locale, dir } of locales) {
  for (const vp of viewports) {
    test(`home ${locale} ${vp.name}px: every status, counts, banner, no overflow, no serious axe violations`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mockHome(page, allStatuses, 3);
      await page.goto(`/operations/${clinicId}?locale=${locale}`);
      await expect(page.locator('.rh-card')).toHaveCount(5);
      await expect(page.locator('.rh-banner')).toBeVisible();
      await expect(
        page.locator('.rh-card--open .rh-card__counts'),
      ).toContainText(
        locale === 'fr'
          ? '4 arrivés · 2 pas encore · 1 appelé · 6 terminés'
          : '4',
      );
      const layout = await page.evaluate(() => ({
        overflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        dir: getComputedStyle(document.body).direction,
      }));
      expect(layout.overflow).toBeLessThanOrEqual(0);
      expect(layout.dir).toBe(dir);

      await page.addScriptTag({ path: axeSource });
      const violations = await page.evaluate(async () => {
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
      expect(violations).toEqual([]);
    });
  }
}

test('empty day keeps the date control and shows no banner without dead letters', async ({
  page,
}) => {
  await mockHome(page, [], 0);
  await page.goto(`/operations/${clinicId}?locale=fr`);
  await expect(page.getByText('Aucune session ce jour-là.')).toBeVisible();
  await expect(page.getByLabel('Date')).toBeVisible();
  await expect(page.locator('.rh-banner')).toHaveCount(0);
});

test('date control: previous and next day reload that day, Aujourd’hui returns', async ({
  page,
}) => {
  await mockHome(page, [], 0);
  const requested: string[] = [];
  await page.route(`**/api/clinics/${clinicId}/sessions?**`, (route) => {
    requested.push(new URL(route.request().url()).searchParams.get('date')!);
    return route.fulfill({ json: { sessions: [], timezone: 'UTC' } });
  });
  await page.goto(`/operations/${clinicId}?locale=fr`);
  const input = page.locator('input[type="date"]');
  await input.fill('2026-03-01');
  await page.getByRole('button', { name: 'Jour précédent' }).click();
  await expect(input).toHaveValue('2026-02-28');
  await page.getByRole('button', { name: 'Jour suivant' }).click();
  await expect(input).toHaveValue('2026-03-01');
  await page.getByRole('button', { name: 'Aujourd’hui' }).click();
  await expect(input).not.toHaveValue('2026-03-01');
  expect(requested).toContain('2026-02-28');
});

test('keyboard only: Tab reaches the console link of an open session', async ({
  page,
}) => {
  await mockHome(page, [allStatuses[1]], 0);
  await page.goto(`/operations/${clinicId}?locale=fr`);
  const link = page.getByRole('link', { name: 'Ouvrir la console' });
  await expect(link).toBeVisible();
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    if (await link.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(link).toBeFocused();
});

test('banner link shows when only guest-link failures exist', async ({
  page,
}) => {
  await mockHome(page, [], 0, 2);
  await page.goto(`/operations/${clinicId}?locale=fr`);
  const banner = page.locator('.rh-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('2 notification');
  await expect(
    banner.getByRole('link', { name: 'Notifications non remises' }),
  ).toBeVisible();
});

test('banner link stays available when a failure source cannot be fetched', async ({
  page,
}) => {
  await mockHome(page, [], 0, 'fail');
  await page.goto(`/operations/${clinicId}?locale=fr`);
  await expect(
    page
      .locator('.rh-banner')
      .getByRole('link', { name: 'Notifications non remises' }),
  ).toBeVisible();
});

test('pause keeps the card counts line (mutation response has no queueCounts)', async ({
  page,
}) => {
  await mockHome(page, [allStatuses[1]], 0);
  const open = allStatuses[1] as Record<string, unknown>;
  const { queueCounts: _omit, ...withoutCounts } = open;
  void _omit;
  await page.route(
    `**/api/clinics/${clinicId}/sessions/${open.id}/commands`,
    (route) =>
      route.fulfill({
        json: { session: { ...withoutCounts, status: 'paused' } },
      }),
  );
  await page.goto(`/operations/${clinicId}?locale=fr`);
  const counts = page.locator('.rh-card__counts');
  await expect(counts).toContainText('4 arrivés');
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.locator('.rh-card--paused')).toHaveCount(1);
  await expect(counts).toContainText('4 arrivés');
  await expect(counts).not.toContainText('Aucun patient');
});
