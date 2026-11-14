import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

// Spec docs/design/reception-console.md "Add a patient", "Today", "Notifications
// alert", "Bulk no-show". All staff API calls are mocked with page.route.
const clinicId = '20000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000002';
const id = (n: number) => `20000000-0000-4000-8000-00000000010${n}`;

function entry(n: number, state: string, over: Record<string, unknown> = {}) {
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
    activeConsultationRemainingMinutes: null,
    eta: null,
    ...over,
  };
}
const baseEntries = [
  entry(1, 'completed'),
  entry(2, 'completed'),
  entry(3, 'no_show'),
  entry(4, 'checked_in'),
  entry(5, 'waiting'),
];
function snapshot(entries: unknown[]) {
  return {
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
  };
}
async function authenticate(page: Page) {
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: 'mocked-staff-session',
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}

type Call = { path: string; body: Record<string, unknown> };
async function mock(
  page: Page,
  opts: { checkInStatus?: number; deadLetters?: number } = {},
) {
  const calls: Call[] = [];
  await page.route('**/api/clinics/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      if (url.pathname.endsWith('/notifications/dead-letters'))
        return route.fulfill({
          json: {
            deadLetters: Array.from(
              { length: opts.deadLetters ?? 0 },
              (_, i) => ({
                id: i,
              }),
            ),
          },
        });
      if (url.pathname.endsWith('/notifications/guest-link-failures'))
        return route.fulfill({ json: { failures: [] } });
      return route.fulfill({ json: snapshot(baseEntries) });
    }
    const path = url.pathname.split('/sessions/')[1]!;
    calls.push({ path, body: request.postDataJSON() });
    if (path.endsWith('/queue'))
      return route.fulfill({
        status: 201,
        json: {
          registration: {
            patient: {
              privateDisplayName: 'Nadia',
              preferredLocale: request.postDataJSON().preferredLocale,
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
    if (opts.checkInStatus && opts.checkInStatus !== 200)
      return route.fulfill({
        status: opts.checkInStatus,
        json: { message: 'Stale entry' },
      });
    return route.fulfill({ json: { entry: entry(6, 'checked_in') } });
  });
  return calls;
}
const url = (locale: string) =>
  `/operations/${clinicId}/sessions/${sessionId}/queue?locale=${locale}`;

test('side panel: today tiles come from the dashboard snapshot', async ({
  page,
}) => {
  await authenticate(page);
  await mock(page);
  await page.goto(url('fr'));
  const tiles = page.getByRole('region', { name: 'Aujourd’hui' });
  await expect(tiles.locator('li').nth(0)).toHaveText('1Arrivés');
  await expect(tiles.locator('li').nth(1)).toHaveText('1Pas encore arrivés');
  await expect(tiles.locator('li').nth(2)).toHaveText('2Terminés');
  await expect(tiles.locator('li').nth(3)).toHaveText('1Absents');
});

test('walk-in: contact-less patient is created then checked in (two steps)', async ({
  page,
}) => {
  await authenticate(page);
  const calls = await mock(page);
  await page.goto(url('fr'));
  const present = page.getByLabel(/Le patient est là/);
  await expect(present).toBeChecked();
  await page.getByLabel('Nom à l’accueil').fill('Nadia');
  await expect(page.getByLabel('Français')).toBeChecked();
  await page.getByRole('button', { name: 'Ajouter à la file' }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[0]!.path).toMatch(/\/queue$/);
  expect(calls[0]!.body).toMatchObject({
    privateDisplayName: 'Nadia',
    contactPhone: null,
    preferredLocale: 'fr',
  });
  expect(calls[1]!.path).toContain(`/queue/${id(6)}/commands`);
  expect(calls[1]!.body.command).toBe('check_in');
});

test('walk-in: unchecked "patient is here" only creates the waiting entry', async ({
  page,
}) => {
  await authenticate(page);
  const calls = await mock(page);
  await page.goto(url('fr'));
  await page.getByLabel(/Le patient est là/).uncheck();
  await page.getByLabel('Nom à l’accueil').fill('Nadia');
  await page.getByLabel('Arabe').check();
  await page.getByRole('button', { name: 'Ajouter à la file' }).click();
  await expect.poll(() => calls.length).toBe(1);
  await page.waitForTimeout(300);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.preferredLocale).toBe('ar');
});

test('walk-in: failed check-in leaves the entry waiting and says so', async ({
  page,
}) => {
  await authenticate(page);
  const calls = await mock(page, { checkInStatus: 409 });
  await page.goto(url('fr'));
  await page.getByLabel('Nom à l’accueil').fill('Nadia');
  await page.getByRole('button', { name: 'Ajouter à la file' }).click();
  await expect(page.locator('.alert')).toContainText(
    'son arrivée n’a pas pu être enregistrée',
  );
  // No rollback: only the create and the one failed check-in were sent.
  expect(calls.map((c) => c.body.command ?? 'create')).toEqual([
    'create',
    'check_in',
  ]);
});

test('undelivered notifications alert only when count > 0, linking to notifications', async ({
  page,
}) => {
  await authenticate(page);
  await mock(page, { deadLetters: 2 });
  await page.goto(url('fr'));
  const alert = page.locator('.undeliveredAlert');
  await expect(alert).toContainText('2 notification(s) non remise(s)');
  await expect(alert.getByRole('link')).toHaveAttribute(
    'href',
    `/operations/${clinicId}/notifications?locale=fr`,
  );

  const clean = await page.context().newPage();
  await mock(clean, { deadLetters: 0 });
  await clean.goto(url('fr'));
  await expect(clean.locator('.todayTiles')).toBeVisible();
  await expect(clean.locator('.undeliveredAlert')).toHaveCount(0);
});

test('Arabic: panel on the left, language defaults to Arabic, phone is LTR, bulk no-show card present', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await authenticate(page);
  await mock(page);
  await page.goto(url('ar'));
  const side = page.locator('.consoleSide');
  const main = page.locator('.consoleMain');
  await expect(side).toBeVisible();
  const [s, m] = [await side.boundingBox(), await main.boundingBox()];
  expect(s!.x).toBeLessThan(m!.x);
  await expect(page.getByLabel('العربية')).toBeChecked();
  await expect(page.locator('input[name="contactPhone"]')).toHaveAttribute(
    'dir',
    'ltr',
  );
  await expect(side).toContainText('تسجيل غياب أصحاب المواعيد');
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.setViewportSize({ width: 1024, height: 768 });
  const narrow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(narrow).toBeLessThanOrEqual(0);
});
