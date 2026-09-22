import { expect, test, type Page } from '@playwright/test';

const BOOKING_URL = '**/api/public/bookings';
const STATUS_URL = '**/api/public/bookings/live-queue-status';
const BEARER = 'manual-retry.test-bearer.signature';

async function mockBooking(page: Page, bearer = BEARER) {
  await page.route(BOOKING_URL, async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ queueLabel: 'G-071', guestBearer: bearer }),
    });
  });
}

async function submitBookingForm(page: Page) {
  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel(/Votre nom|اسمك/).fill('Test Guest');
  await page.getByRole('button', { name: /Confirmer|تأكيد/ }).click();
}

// Drives the shared polling loop through five consecutive transient
// failures (matching MAX_TRANSIENT_FAILURES) so the offline/exhausted
// screen appears, using the virtual clock instead of wall-clock sleeps.
async function exhaustAutomaticPolling(
  page: Page,
  expectRequests: (count: number) => Promise<void>,
) {
  await expectRequests(1);
  await page.clock.fastForward(6_000);
  await expectRequests(2);
  await page.clock.fastForward(16_000);
  await expectRequests(3);
  await page.clock.fastForward(31_000);
  await expectRequests(4);
  await page.clock.fastForward(61_000);
  await expectRequests(5);
}

test('manual retry shows accessible pending feedback, stays bound to one in-flight request, and recovers', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  let releaseRetry: (() => void) | undefined;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (requests <= 5) {
      await route.fulfill({ status: 503, body: '' });
      return;
    }
    if (requests === 6) {
      await new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await exhaustAutomaticPolling(page, async (count) =>
    expect.poll(() => requests).toBe(count),
  );

  await expect(page.getByText(/Connexion interrompue/)).toBeVisible();
  const retry = page.getByRole('button', { name: 'Réessayer maintenant' });
  await retry.click();

  const pending = page.getByRole('button', {
    name: 'Nouvelle tentative en cours…',
  });
  await expect(pending).toBeDisabled();
  await expect(pending).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('manual-retry-feedback')).toHaveText(
    'Nouvelle tentative en cours…',
  );

  // A repeated click while the retry is pending must not start a second
  // request; the offline screen must never look inert or double-fire.
  await pending.evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => requests).toBe(6);

  releaseRetry?.();
  await expect(page.getByText(/en attente/)).toBeVisible();
  await expect(page.getByTestId('manual-retry-feedback')).toHaveCount(0);
  expect(requests).toBe(6);
});

test('manual retry failure preserves the last verified timestamp and reports truthful failure feedback', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-09-20T12:00:00.000Z'));
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          bookingState: 'confirmed',
          queueState: 'waiting',
        }),
      });
      return;
    }
    await route.fulfill({ status: 503, body: '' });
  });

  await submitBookingForm(page);
  await expect.poll(() => requests).toBe(1);
  const verified = page.locator('time[datetime]');
  await expect(verified).toHaveAttribute(
    'datetime',
    '2026-09-20T12:00:00.000Z',
  );

  await page.clock.fastForward(31_000);
  await expect.poll(() => requests).toBe(2);
  await page.clock.fastForward(6_000);
  await expect.poll(() => requests).toBe(3);
  await page.clock.fastForward(16_000);
  await expect.poll(() => requests).toBe(4);
  await page.clock.fastForward(31_000);
  await expect.poll(() => requests).toBe(5);
  await page.clock.fastForward(61_000);
  await expect.poll(() => requests).toBe(6);

  await expect(page.getByText(/Connexion interrompue/)).toBeVisible();
  await page.getByRole('button', { name: 'Réessayer maintenant' }).click();
  await expect.poll(() => requests).toBe(7);

  await expect(page.getByTestId('manual-retry-feedback')).toHaveText(
    'La nouvelle tentative a échoué. La dernière heure vérifiée reste affichée.',
  );
  await expect(verified).toHaveAttribute(
    'datetime',
    '2026-09-20T12:00:00.000Z',
  );
  await expect(
    page.getByRole('heading', { name: 'Connexion interrompue' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Statut potentiellement obsolète' }),
  ).toBeVisible();
  expect(page.url()).not.toContain(BEARER);
});

test('Arabic RTL manual retry announces pending status and recovers to the live view', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'ar-DZ',
    });
  });
  await mockBooking(page);
  let requests = 0;
  let releaseRetry: (() => void) | undefined;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (requests <= 5) {
      await route.fulfill({ status: 503, body: '' });
      return;
    }
    if (requests === 6) {
      await new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await exhaustAutomaticPolling(page, async (count) =>
    expect.poll(() => requests).toBe(count),
  );

  await expect(page.getByText(/انقطع الاتصال/)).toBeVisible();
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
  const retry = page.getByRole('button', { name: 'إعادة المحاولة الآن' });
  await retry.click();

  const pending = page.getByRole('button', { name: 'إعادة المحاولة جارية…' });
  await expect(pending).toBeDisabled();
  await expect(pending).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('manual-retry-feedback')).toHaveText(
    'إعادة المحاولة جارية…',
  );

  releaseRetry?.();
  await expect(page.getByText(/في الانتظار/)).toBeVisible();
  await expect(page.getByTestId('manual-retry-feedback')).toHaveCount(0);
  expect(requests).toBe(6);
  expect(page.url()).not.toContain(BEARER);
});
