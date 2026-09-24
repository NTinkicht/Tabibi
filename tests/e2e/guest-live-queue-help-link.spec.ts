import { expect, test, type Page } from '@playwright/test';

const BOOKING_URL = '**/api/public/bookings';
const STATUS_URL = '**/api/public/bookings/live-queue-status';
const STREAM_URL = '**/api/public/bookings/live-queue-stream';
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

  const response = await submitBookingForm(page);

  await expect(page.getByText('G-042')).toBeVisible();
  await expect(page.getByText(/en attente/)).toBeVisible();

  const helpLink = page.getByTestId('guest-live-queue-help-link');
  await expect(helpLink).toBeVisible();
  await expect(helpLink).toHaveText('Voir toutes les rubriques d\'aide');
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

  const response = await submitBookingForm(page);

  await expect(page.getByText('G-042')).toBeVisible();

  const helpLink = page.getByTestId('guest-live-queue-help-link');
  await expect(helpLink).toBeVisible();
  await expect(helpLink).toHaveText('عرض جميع مواضيع المساعدة');
  await expect(helpLink).toHaveAttribute('href', '/guest/help');

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

  await submitBookingForm(page);

  await expect(page.getByText('G-042')).toBeVisible();

  const helpLink = page.getByTestId('guest-live-queue-help-link');
  await expect(helpLink).toBeVisible();

  await expect(page.getByText(/en attente|تم تسجيل الوصول/)).toBeVisible();
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
