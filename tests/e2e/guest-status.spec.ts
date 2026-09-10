import { expect, test } from '@playwright/test';

const activeWaiting = {
  generatedAt: '2026-09-10T09:00:00Z',
  terminal: false,
  publicDisplayLabel: 'G-018',
  queueState: 'waiting',
  clinicTimezone: 'Africa/Algiers',
  patientsAhead: null,
  positionKind: 'provisional',
  arrivalWindow: {
    earliestAt: '2026-09-10T09:30:00Z',
    latestAt: '2026-09-10T09:45:00Z',
    uncertaintyMinutes: 15,
  },
  session: { status: 'open', declaredDelayMinutes: 10 },
};

const activeEligible = {
  ...activeWaiting,
  queueState: 'checked_in',
  patientsAhead: 2,
  positionKind: 'live' as const,
  arrivalWindow: null,
};

test('guest status renders provisional waiting state without leaking bearer material', async ({
  page,
}) => {
  const rawBearer = '00000000-0000-4000-8000-000000000018.test-guest-bearer';
  await page.context().addCookies([
    {
      name: '__Host-tabibi_guest',
      value: rawBearer,
      // __Host- cookies are Secure-only. Seed it against the HTTPS form of
      // localhost so Chromium accepts the production cookie attributes; the
      // cookie remains host-only (no Domain attribute) and path=/ by prefix rule.
      url: 'https://localhost:3000',
      secure: true,
      httpOnly: true,
    },
  ]);
  let statusRequestCookie = '';
  await page.route('**/api/guest/status', async (route) => {
    statusRequestCookie = route.request().headers()['cookie'] ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeWaiting),
    });
  });

  const response = await page.goto('http://localhost:3000/guest/status');
  await expect(page.getByText('G-018')).toBeVisible();
  await expect(page.getByText(/Expected arrival window:/)).toBeVisible();
  await expect(page.getByText(/Declared clinic delay:/)).toBeVisible();
  expect(statusRequestCookie).toContain(`__Host-tabibi_guest=${rawBearer}`);
  expect(await page.locator('body').innerText()).not.toContain(rawBearer);
  expect(page.url()).not.toContain(rawBearer);
  expect(
    await page.evaluate(() => [
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ]),
  ).not.toContain(rawBearer);
  expect(response?.headers()['cache-control']).toContain('no-store');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  expect(response?.headers()['content-security-policy']).toContain(
    "default-src 'self'",
  );
});

test('guest status renders exact patients-ahead only for a live eligible snapshot', async ({
  page,
}) => {
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeEligible),
    });
  });

  await page.goto('http://localhost:3000/guest/status');
  await expect(page.getByText('Patients ahead:')).toBeVisible();
  await expect(page.getByText('2')).toBeVisible();
  await expect(page.getByText(/Expected arrival window:/)).toHaveCount(0);
});

test('guest status stops polling after a terminal snapshot', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/guest/status', async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: '2026-09-10T09:00:00Z',
        terminal: true,
        finalStatus: 'completed',
      }),
    });
  });

  await page.goto('http://localhost:3000/guest/status');
  await expect(page.getByText('completed')).toBeVisible();
  await page.waitForTimeout(31_000);
  expect(requests).toBe(1);
});

test('guest status stops polling after unauthorized response', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/guest/status', async (route) => {
    requests += 1;
    await route.fulfill({ status: 401, body: '{}' });
  });

  await page.goto('http://localhost:3000/guest/status');
  await expect(page.getByText('Guest access unavailable')).toBeVisible();
  await page.waitForTimeout(31_000);
  expect(requests).toBe(1);
});

test('guest status honors bounded Retry-After before retrying', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/guest/status', async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({ status: 429, headers: { 'Retry-After': '1' }, body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeWaiting),
    });
  });

  await page.goto('http://localhost:3000/guest/status');
  await expect(page.getByText('G-018')).toBeVisible({ timeout: 5_000 });
  expect(requests).toBe(2);
});
