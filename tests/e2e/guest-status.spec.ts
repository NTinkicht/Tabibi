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

test('guest status renders provisional waiting state without leaking bearer material', async ({ page }) => {
  const rawBearer = '00000000-0000-4000-8000-000000000018.test-guest-bearer';
  await page.context().addCookies([
    {
      name: '__Host-tabibi_guest',
      value: rawBearer,
      url: 'http://localhost:3000',
      secure: true,
      httpOnly: true,
    },
  ]);
  let statusRequestCookie = '';
  await page.route('**/api/guest/status', async (route) => {
    statusRequestCookie = route.request().headers()['cookie'] ?? '';
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeWaiting) });
  });

  const response = await page.goto('http://localhost:3000/guest/status');
  await expect(page.getByText('G-018')).toBeVisible();
  await expect(page.getByText(/Expected arrival window:/)).toBeVisible();
  await expect(page.getByText(/Declared clinic delay:/)).toBeVisible();
  expect(statusRequestCookie).toContain(`__Host-tabibi_guest=${rawBearer}`);
  expect(await page.locator('body').innerText()).not.toContain(rawBearer);
  expect(page.url()).not.toContain(rawBearer);
  expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)])).not.toContain(rawBearer);
  expect(response?.headers()['cache-control']).toContain('no-store');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
});

test('guest status renders exact patients-ahead only for a live eligible snapshot', async ({ page }) => {
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeEligible) });
  });
  await page.goto('/guest/status');
  await expect(page.getByText('Patients ahead: 2')).toBeVisible();
  await expect(page.getByText(/Expected arrival window:/)).toHaveCount(0);
});

test('guest status stops on terminal response', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/guest/status', async (route) => {
    requests += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ generatedAt: '2026-09-10T09:05:00Z', terminal: true, finalStatus: 'completed' }) });
  });
  await page.goto('/guest/status');
  await expect(page.getByRole('heading', { name: 'Visit status' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(requests).toBe(1);
});

test('guest status stops on unauthorized response', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/guest/status', async (route) => {
    requests += 1;
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/guest/status');
  await expect(page.getByRole('heading', { name: 'Guest access unavailable' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(requests).toBe(1);
});

test('guest status honors Retry-After before retrying a throttled request', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/guest/status', async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({ status: 429, headers: { 'retry-after': '1' }, body: '{}' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeEligible) });
  });
  await page.goto('/guest/status');
  await page.waitForTimeout(300);
  expect(requests).toBe(1);
  await expect(page.getByText('Patients ahead: 2')).toBeVisible({ timeout: 2_000 });
  expect(requests).toBe(2);
});

test('guest status renders paused and planned session states explicitly', async ({ page }) => {
  let status = 'paused';
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...activeEligible, session: { status, declaredDelayMinutes: null } }) });
  });
  await page.goto('/guest/status');
  await expect(page.getByText(/Clinic session:/)).toBeVisible();
  await expect(page.getByText(/temporarily paused/)).toBeVisible();
  status = 'planned';
  await page.reload();
  await expect(page.getByText(/not started yet/)).toBeVisible();
});

test('guest status selects French copy from browser locale', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'language', { get: () => 'fr-DZ' }); });
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeEligible) });
  });
  await page.goto('/guest/status');
  await expect(page.getByText('Patients avant vous : 2')).toBeVisible();
  await expect(page.locator('section[lang="fr"][dir="ltr"]')).toBeVisible();
});

test('guest status selects Arabic RTL copy from browser locale', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'language', { get: () => 'ar-DZ' }); });
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeEligible) });
  });
  await page.goto('/guest/status');
  await expect(page.getByText('المرضى قبلك: 2')).toBeVisible();
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
});

test('guest status formats arrival times in the clinic timezone', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'language', { get: () => 'fr-DZ' }); });
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeWaiting) });
  });
  await page.goto('/guest/status');
  await expect(page.getByText(/10:30.*10:45/)).toBeVisible();
});
