import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

// Spec docs/design/reception-console.md "Tablet": 1024x768, touch emulation.
// Staff APIs are mocked with page.route; no server session is needed.
const clinicId = '20000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000002';
const id = (n: number) => `20000000-0000-4000-8000-00000000010${n}`;

function entry(n: number, state: string) {
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
    origin: 'walk_in',
    appointmentStartsAt: null,
    activeConsultationRemainingMinutes: state === 'in_consultation' ? 7 : null,
    eta:
      state === 'checked_in'
        ? { minWaitMinutes: 10, maxWaitMinutes: 25 }
        : null,
  };
}
const entries = [
  entry(1, 'in_consultation'),
  entry(2, 'called'),
  entry(3, 'checked_in'),
  entry(4, 'checked_in'),
  entry(5, 'waiting'),
];

async function mock(page: Page) {
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: 'mocked-staff-session',
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  const posts: string[] = [];
  await page.route('**/api/clinics/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      if (url.pathname.endsWith('/notifications/dead-letters'))
        return route.fulfill({ json: { deadLetters: [] } });
      if (url.pathname.endsWith('/notifications/guest-link-failures'))
        return route.fulfill({ json: { failures: [] } });
      return route.fulfill({
        json: {
          entries,
          session: {
            doctorDisplayName: 'Dr Leila',
            startsAt: '2026-09-08T09:00:00.000Z',
            endsAt: '2026-09-08T12:00:00.000Z',
            status: 'open',
            declaredDelayMinutes: null,
            delayVersion: 1,
            queueOrderVersion: 1,
          },
          generatedAt: new Date().toISOString(),
          refreshAfterSeconds: 30,
        },
      });
    }
    posts.push(url.pathname.split('/sessions/')[1]!);
    return route.fulfill({
      status: 201,
      json: {
        registration: {
          patient: {
            privateDisplayName: 'Nadia',
            preferredLocale: 'fr',
            hasContact: false,
          },
          entry: {
            id: id(6),
            sessionId,
            state: 'waiting',
            registrationOrder: 6,
            publicDisplayLabel: 'A-06',
          },
        },
      },
    });
  });
  return posts;
}

test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } });

for (const [locale, add, close, side, counts, back] of [
  [
    'fr',
    'Ajouter un patient',
    'Fermer',
    'right',
    'Arrivés 2 · Pas encore arrivés 1 · Terminés 0 · Absents 0',
    'Retour aux sessions',
  ],
  [
    'ar',
    'إضافة مريض',
    'إغلاق',
    'left',
    'وصلوا 2 · لم يصلوا بعد 1 · انتهوا 0 · غائبون 0',
    'العودة إلى الجلسات',
  ],
] as const) {
  test(`tablet console ${locale}: layout, targets and panel`, async ({
    page,
  }) => {
    const posts = await mock(page);
    await page.goto(
      `/operations/${clinicId}/sessions/${sessionId}/queue?locale=${locale}`,
    );
    // Positive control: touch emulation really matches the tablet query.
    expect(
      await page.evaluate(
        () =>
          window.matchMedia(
            '(min-width: 700px) and (max-width: 1199px) and (pointer: coarse)',
          ).matches,
      ),
    ).toBe(true);
    await expect(page.locator('.queueRow.consoleRow').first()).toBeVisible();

    // Header: 60 px, session switcher (doctor + hours) back to the sessions
    // home and today's counts on one line; the desktop tiles are replaced.
    const header = await page.locator('.deskHeader').boundingBox();
    expect(header!.height).toBeGreaterThanOrEqual(60);
    expect(header!.height).toBeLessThan(96);
    const switcher = page.locator('.sessionSwitcher');
    await expect(switcher).toBeVisible();
    await expect(switcher).toContainText('Dr Leila');
    await expect(switcher).toHaveAttribute(
      'href',
      `/operations/${clinicId}?locale=${locale}`,
    );
    await expect(switcher).toHaveAttribute('aria-label', new RegExp(back));
    expect((await switcher.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('.countsLine')).toHaveText(counts);
    await expect(page.locator('.todayTiles')).toBeHidden();

    // No horizontal scroll; 300 px in-progress column beside the queue.
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const serving = await page.locator('.servingRegion').boundingBox();
    const queue = await page.locator('.queueRegion').boundingBox();
    expect(Math.round(serving!.width)).toBe(300);
    expect(Math.abs(serving!.y - queue!.y)).toBeLessThan(4);

    // Targets: every visible button/input in the main column is >= 44 px, the
    // Call next button >= 60 px and rows >= 64 px.
    const small = await page.evaluate(
      () =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '.consoleMain button, .consoleMain input, .sessionBar button',
          ),
        )
          .filter((el) => el.offsetParent !== null)
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.height < 43.5 || r.width < 43.5).length,
    );
    expect(small).toBe(0);
    const callNext = await page.locator('.sessionBar .callNext').boundingBox();
    expect(callNext!.height).toBeGreaterThanOrEqual(60);
    const row = await page
      .locator('.queueRow.consoleRow')
      .first()
      .boundingBox();
    expect(row!.height).toBeGreaterThanOrEqual(64);
    // All six row cells share one line: the actions do not wrap under the
    // others, so the row stays a single band within its own box.
    const rowShape = await page.evaluate(() => {
      const r = document.querySelector('.queueRow.consoleRow')!;
      const box = r.getBoundingClientRect();
      const mids = Array.from(r.children).map((c) => {
        const b = c.getBoundingClientRect();
        return b.top + b.height / 2 - box.top;
      });
      return { cells: r.children.length, height: box.height, mids };
    });
    expect(rowShape.cells).toBe(6);
    expect(rowShape.height).toBeLessThan(96);
    for (const mid of rowShape.mids)
      expect(Math.abs(mid - rowShape.height / 2)).toBeLessThan(24);

    // The walk-in panel is closed, hidden from the tab order, and opens as a
    // modal dialog on the inline-end side.
    const opener = page.getByRole('button', { name: add });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('input[name="privateDisplayName"]')).toBeHidden();
    const openerBox = await opener.boundingBox();
    expect(openerBox!.height).toBeGreaterThanOrEqual(56);
    await opener.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(
      page.locator('input[name="privateDisplayName"]'),
    ).toBeFocused();
    const box = await dialog.boundingBox();
    if (side === 'right') expect(Math.round(box!.x + box!.width)).toBe(1024);
    else expect(Math.round(box!.x)).toBe(0);
    expect(Math.round(box!.width)).toBe(400);
    const name = await page
      .locator('input[name="privateDisplayName"]')
      .boundingBox();
    expect(name!.height).toBeGreaterThanOrEqual(52);

    // Focus is trapped: tabbing past the last control wraps inside the panel.
    for (let i = 0; i < 12; i += 1) await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() =>
        document
          .querySelector('[role="dialog"]')!
          .contains(document.activeElement),
      ),
    ).toBe(true);

    // Escape closes and returns focus to the opener, with nothing sent.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(posts).toEqual([]);

    // The close button does the same.
    await opener.click();
    await page.getByRole('dialog').getByRole('button', { name: close }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();

    // Submitting issues the same two commands as desktop and closes the panel.
    await opener.click();
    await page.locator('input[name="privateDisplayName"]').fill('Nadia');
    await page.locator('#walkInTitle ~ form > button').click();
    await expect.poll(() => posts.length).toBeGreaterThan(0);
    expect(posts[0]).toMatch(/\/queue$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

test('desktop pointer keeps the side panel inline (negative control)', async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: false,
    viewport: { width: 1024, height: 768 },
  });
  const page = await context.newPage();
  await mock(page);
  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=fr`,
  );
  await expect(page.locator('input[name="privateDisplayName"]')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.sessionSwitcher')).toBeHidden();
  await expect(page.locator('.countsLine')).toBeHidden();
  await expect(page.locator('.todayTiles')).toBeVisible();
  await context.close();
});

test('coarse phone width keeps the stacked layout (no tablet panel)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page);
  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=fr`,
  );
  await expect(page.locator('.queueRow.consoleRow').first()).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.matchMedia(
          '(min-width: 700px) and (max-width: 1199px) and (pointer: coarse)',
        ).matches,
    ),
  ).toBe(false);
  await expect(
    page.getByRole('button', { name: 'Ajouter un patient' }),
  ).toHaveCount(0);
  await expect(page.locator('input[name="privateDisplayName"]')).toBeVisible();
  const serving = await page.locator('.servingRegion').boundingBox();
  expect(serving!.width).toBeGreaterThan(300);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
