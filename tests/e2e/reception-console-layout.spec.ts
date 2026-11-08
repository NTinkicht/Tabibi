import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

// Spec docs/design/reception-console.md "Acceptance": both locales at 1440 and
// 1024 px, no horizontal scroll, RTL mirroring, and no serious/critical axe
// violations. Staff APIs are mocked with page.route; no server session needed.
const clinicId = '20000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000002';
const id = (n: number) => `20000000-0000-4000-8000-00000000010${n}`;
const axeSource = require.resolve('axe-core/axe.min.js');

type S = 'checked_in' | 'waiting' | 'called' | 'in_consultation';
function entry(n: number, state: S, over: Record<string, unknown> = {}) {
  return {
    id: id(n),
    sessionId,
    state,
    registrationOrder: n,
    publicDisplayLabel: `A-0${n}`,
    privateDisplayName: `Patient ${n}`,
    preferredLocale: 'fr',
    hasContact: false,
    eligibilityOrder: state === 'waiting' ? null : n,
    priorityOrder: null,
    origin: n === 4 ? 'appointment' : 'walk_in',
    appointmentStartsAt: n === 4 ? '2026-09-08T10:30:00.000Z' : null,
    activeConsultationRemainingMinutes: state === 'in_consultation' ? 7 : null,
    eta:
      state === 'checked_in'
        ? { minWaitMinutes: 10 * n, maxWaitMinutes: 10 * n + 15 }
        : null,
    ...over,
  };
}

async function mockConsole(page: Page, status: 'open' | 'paused') {
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: 'mocked-staff-session',
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  const entries = [
    entry(1, 'in_consultation'),
    entry(5, 'called'),
    entry(2, 'checked_in'),
    entry(3, 'checked_in'),
    entry(4, 'waiting'),
  ];
  await page.route('**/api/clinics/**', (route) =>
    route.fulfill({
      json: {
        entries,
        session: {
          doctorDisplayName: 'Dr Leila',
          startsAt: '2026-09-08T09:00:00.000Z',
          endsAt: '2026-09-08T12:00:00.000Z',
          status,
          declaredDelayMinutes: 10,
          delayVersion: 1,
          queueOrderVersion: 1,
        },
        generatedAt: new Date().toISOString(),
        refreshAfterSeconds: 30,
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
    for (const status of ['open', 'paused'] as const) {
      test(`console ${locale} ${vp.name}px ${status}: no horizontal scroll, direction, no serious/critical axe violations`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await mockConsole(page, status);
        await page.goto(
          `/operations/${clinicId}/sessions/${sessionId}/queue?locale=${locale}`,
        );
        await expect(page.locator('.consoleRow').first()).toBeVisible();

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
                  violations: Array<{
                    id: string;
                    impact: string | null;
                    nodes: Array<{ target: unknown }>;
                  }>;
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
            .map((v) => ({
              id: v.id,
              impact: v.impact,
              targets: v.nodes.map((n) => n.target),
            }));
        });
        expect(violations).toEqual([]);
      });
    }
  }
}
