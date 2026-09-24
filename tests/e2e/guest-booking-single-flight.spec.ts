import { expect, test, type Page } from '@playwright/test';

const BOOKING_URL = '**/api/public/bookings';
const STATUS_URL = '**/api/public/bookings/live-queue-status';
const BEARER = 'single-flight.test-guest-bearer-secret.signature';

type BookingFulfillment = { status: number; body?: unknown };

type PendingBookingRequest = {
  idempotencyKey: string | null;
  resolve: (fulfillment: BookingFulfillment) => void;
};

type CountedWindow = typeof window & { __bookingFetchCallCount: number };

/**
 * Counts calls to `fetch('/api/public/bookings', ...)` synchronously inside
 * the page, before the network layer is ever reached. `submitFormTwice`
 * dispatches both submit events synchronously, so by the time it resolves
 * this counter already reflects exactly how many times `submitBooking`
 * actually called `fetch` -- unlike counting requests received by Playwright
 * routing, which depends on network round-trip timing and would make a
 * regression in the synchronous guard only flaky-detectable.
 */
async function trackBookingFetchCalls(page: Page) {
  await page.addInitScript(() => {
    const counted = window as CountedWindow;
    counted.__bookingFetchCallCount = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      if (url.endsWith('/api/public/bookings')) {
        counted.__bookingFetchCallCount += 1;
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;
  });
}

function getBookingFetchCallCount(page: Page) {
  return page.evaluate(() => (window as CountedWindow).__bookingFetchCallCount);
}

/**
 * Routes `/api/public/bookings` so each request is held open until the test
 * explicitly resolves it, in request order. This lets a test assert exactly
 * how many POSTs actually reached the server once one is deliberately kept
 * pending.
 */
async function mockControlledBooking(page: Page) {
  const pending: PendingBookingRequest[] = [];
  let requestCount = 0;
  await page.route(BOOKING_URL, async (route) => {
    requestCount += 1;
    const idempotencyKey = route.request().headers()['idempotency-key'] ?? null;
    const fulfillment = await new Promise<BookingFulfillment>((resolve) => {
      pending.push({ idempotencyKey, resolve });
    });
    if (fulfillment.body === undefined) {
      await route.fulfill({ status: fulfillment.status, body: '' });
      return;
    }
    await route.fulfill({
      status: fulfillment.status,
      contentType: 'application/json',
      body: JSON.stringify(fulfillment.body),
    });
  });
  return {
    getRequestCount: () => requestCount,
    getPendingIdempotencyKeys: () =>
      pending.map((entry) => entry.idempotencyKey),
    resolveNext(fulfillment: BookingFulfillment) {
      const next = pending.shift();
      if (!next) throw new Error('no pending booking request to resolve');
      next.resolve(fulfillment);
    },
  };
}

function mockLiveQueueStatus(page: Page) {
  return page.route(STATUS_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    }),
  );
}

/** Fires two submit attempts back-to-back in the same task, simulating a
 * rapid double click or repeated Enter before React has re-rendered the
 * form with `disabled` controls. */
function submitFormTwice(page: Page) {
  return page.evaluate(() => {
    const form = document.querySelector('form');
    form?.requestSubmit();
    form?.requestSubmit();
  });
}

async function assertBearerNeverExposed(page: Page) {
  expect(page.url()).not.toContain(BEARER);
  expect(await page.locator('body').innerText()).not.toContain(BEARER);
  expect(await page.content()).not.toContain(BEARER);
}

test('French guest booking rejects a duplicate submit while the POST is pending and opens the live queue once released', async ({
  page,
}) => {
  await trackBookingFetchCalls(page);
  const booking = await mockControlledBooking(page);
  await mockLiveQueueStatus(page);
  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel('Votre nom').fill('Guest Un');
  await page.locator('input[type="email"]').fill('guest@example.test');

  await submitFormTwice(page);
  expect(await getBookingFetchCallCount(page)).toBe(1);
  await expect.poll(() => booking.getRequestCount()).toBe(1);

  const pendingButton = page.getByRole('button', {
    name: 'Confirmation en cours…',
  });
  await expect(pendingButton).toBeDisabled();
  await expect(page.getByLabel('Votre nom')).toBeDisabled();

  // A further attempt while still pending must not start a second POST.
  await submitFormTwice(page);
  expect(await getBookingFetchCallCount(page)).toBe(1);
  expect(booking.getRequestCount()).toBe(1);

  booking.resolveNext({
    status: 201,
    body: { queueLabel: 'G-901', guestBearer: BEARER },
  });

  await expect(page.getByText('G-901')).toBeVisible();
  expect(await getBookingFetchCallCount(page)).toBe(1);
  expect(booking.getRequestCount()).toBe(1);
  await assertBearerNeverExposed(page);
});

test('Arabic RTL guest booking rejects duplicate submits, then a genuine retry after a 503 reuses the same idempotency key', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'ar-DZ',
    });
  });
  await trackBookingFetchCalls(page);
  const booking = await mockControlledBooking(page);
  await mockLiveQueueStatus(page);
  await page.goto('/guest/live-queue/test-selection-ref');
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
  await page.getByLabel('اسمك').fill('ضيف');
  await page.locator('input[type="email"]').fill('guest@example.test');

  await submitFormTwice(page);
  expect(await getBookingFetchCallCount(page)).toBe(1);
  await expect.poll(() => booking.getRequestCount()).toBe(1);
  await expect(
    page.getByRole('button', { name: 'جارٍ التأكيد…' }),
  ).toBeDisabled();

  const firstKey = booking.getPendingIdempotencyKeys()[0];
  expect(firstKey).toBeTruthy();

  booking.resolveNext({ status: 503 });

  await expect(
    page.getByRole('heading', { name: 'الحجز غير متاح' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'تأكيد الحجز' })).toBeEnabled();

  // Genuine retry after failure: also guarded against a duplicate submit,
  // and must carry the same idempotency key as the failed attempt.
  await submitFormTwice(page);
  expect(await getBookingFetchCallCount(page)).toBe(2);
  await expect.poll(() => booking.getRequestCount()).toBe(2);
  expect(booking.getPendingIdempotencyKeys()[0]).toBe(firstKey);

  booking.resolveNext({
    status: 201,
    body: { queueLabel: 'G-902', guestBearer: BEARER },
  });

  await expect(page.getByText('G-902')).toBeVisible();
  expect(await getBookingFetchCallCount(page)).toBe(2);
  expect(booking.getRequestCount()).toBe(2);
  await assertBearerNeverExposed(page);
});
