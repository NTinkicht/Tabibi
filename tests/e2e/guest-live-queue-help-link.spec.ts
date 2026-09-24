import { expect, test, type Page } from '@playwright/test';

const BOOKING_URL = '**/api/public/bookings';
const STATUS_URL = '**/api/public/bookings/live-queue-status';
const BEARER = 'test-selection.test-guest-bearer-secret.signature';

async function mockBooking(page: Page, bearer = BEARER) {
  await page.route(BOOKING_URL, async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        serviceDate: '2099-05-15',
        startsAt: '2099-05-15T08:00:00.000Z',
        endsAt: '2099-05-15T09:00:00.000Z',
        queueLabel: 'G-042',
        guestBearer: bearer,
        guestAccessExpiresAt: '2099-05-16T08:00:00.000Z',
      }),
    });
  });
}

async function submitBookingForm(page: Page) {
  const response = await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel(/Votre nom|اسمك/).fill('Test Guest');
  await page.locator('input[type="email"]').fill('guest@example.test');
  await page.getByRole('button', { name: /Confirmer|تأكيد/ }).click();
  return response;
}

test('guest live queue displays FR help hub link without bearer token', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    });
  });

  await submitBookingForm(page);

  await expect(page.getByText('G-042')).toBeVisible();
  await expect(page.getByText(/en attente/)).toBeVisible();

  const helpLink = page.getByTestId('guest-live-queue-help-link');
  await expect(helpLink).toBeVisible();
  await expect(helpLink).toHaveText("Voir toutes les rubriques d'aide");
  await expect(helpLink).toHaveAttribute('href', '/guest/help');

  expect(await page.locator('body').innerText()).not.toContain(BEARER);
  expect(page.url()).not.toContain(BEARER);
  expect(
    await page.evaluate(() => [
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ]),
  ).not.toContain(BEARER);
});

test('guest live queue displays AR help hub link without bearer token', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'ar-DZ' });
  });
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    });
  });

  await submitBookingForm(page);

  await expect(page.getByText('G-042')).toBeVisible();

  const helpLink = page.getByTestId('guest-live-queue-help-link');
  await expect(helpLink).toBeVisible();
  await expect(helpLink).toHaveText('عرض جميع مواضيع المساعدة');
  await expect(helpLink).toHaveAttribute('href', '/guest/help');
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();

  expect(await page.locator('body').innerText()).not.toContain(BEARER);
  expect(page.url()).not.toContain(BEARER);
});

test('guest live queue help link preserves queue polling and status', async ({
  page,
}) => {
  await mockBooking(page);
  let pollCount = 0;
  await page.route(STATUS_URL, async (route) => {
    pollCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: pollCount === 1 ? 'waiting' : 'checked_in',
      }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);

  await expect(page.getByText('G-042')).toBeVisible();

  const helpLink = page.getByTestId('guest-live-queue-help-link');
  await expect(helpLink).toBeVisible();
  await expect.poll(() => pollCount).toBeGreaterThanOrEqual(1);

  await page.clock.fastForward(30_000);
  await expect.poll(() => pollCount).toBeGreaterThanOrEqual(2);
  await expect(page.getByText('enregistré')).toBeVisible();
  await expect(helpLink).toBeVisible();
});

test('guest live queue help link does not expose capability tokens in DOM', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    });
  });

  await submitBookingForm(page);

  const helpLink = page.getByTestId('guest-live-queue-help-link');
  await expect(helpLink).toBeVisible();

  const href = await helpLink.getAttribute('href');
  expect(href).not.toContain(BEARER);
  expect(href).not.toContain('bearer');
  expect(href).not.toContain('guestBearer');

  const outerHTML = await helpLink.evaluate((el) => el.outerHTML);
  expect(outerHTML).not.toContain(BEARER);
});

test('opens help in a new tab without losing the live guest session', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    });
  });

  await submitBookingForm(page);
  await expect(page.getByText('G-042')).toBeVisible();
  await expect(page.getByText(/en attente/)).toBeVisible();

  const helpLink = page.getByTestId('guest-live-queue-help-link');
  await expect(helpLink).toHaveAttribute('href', '/guest/help');
  await expect(helpLink).toHaveAttribute('target', '_blank');
  await expect(helpLink).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(helpLink).toHaveAttribute(
    'aria-describedby',
    'tabibi-guest-help-new-tab-hint',
  );
  await expect(page.locator('#tabibi-guest-help-new-tab-hint')).toHaveText(
    '(s’ouvre dans un nouvel onglet)',
  );

  const popupPromise = page.waitForEvent('popup');
  await helpLink.click();
  const helpPage = await popupPromise;
  await expect(helpPage).toHaveURL(/\\/guest\\/help$/);
  expect(helpPage.url()).not.toContain(BEARER);
  await helpPage.close();

  await expect(page).toHaveURL(/\\/guest\\/live-queue\\/test-selection-ref$/);
  await expect(page.getByText('G-042')).toBeVisible();
  await expect(page.getByText(/en attente/)).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain(BEARER);
  expect(
    await page.evaluate(() => [
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ]),
  ).not.toContain(BEARER);
});

test('help link remains reachable while the first live status is loading', async ({
  page,
}) => {
  await mockBooking(page);
  let releaseStatus: (() => void) | undefined;
  await page.route(STATUS_URL, async (route) => {
    await new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    });
  });

  await submitBookingForm(page);
  await expect.poll(() => releaseStatus !== undefined).toBe(true);
  await expect(page.getByText('Chargement de votre statut…')).toBeVisible();
  const helpLink = page.getByTestId('guest-live-queue-help-link');
  await expect(helpLink).toBeVisible();
  await expect(helpLink).toHaveAttribute('target', '_blank');
  releaseStatus?.();
  await expect(page.getByText(/en attente/)).toBeVisible();
  await expect(helpLink).toBeVisible();
});

test('help link remains reachable when guest live status is unavailable', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'invalid guest access' }),
    });
  });

  await submitBookingForm(page);
  await expect(
    page.getByRole('heading', { name: 'Accès indisponible' }),
  ).toBeVisible();
  const helpLink = page.getByTestId('guest-live-queue-help-link');
  await expect(helpLink).toBeVisible();
  await expect(helpLink).toHaveAttribute('href', '/guest/help');
  await expect(helpLink).toHaveAttribute('target', '_blank');
  expect(page.url()).not.toContain(BEARER);
});
