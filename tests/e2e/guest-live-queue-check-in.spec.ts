import { expect, test, type Page } from '@playwright/test';

const BOOKING_URL = '**/api/public/bookings';
const STATUS_URL = '**/api/public/bookings/live-queue-status';
const CHECK_IN_URL = '**/api/public/bookings/check-in';
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

async function mockWaitingStatus(page: Page) {
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
}

async function submitBookingForm(page: Page) {
  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel(/Votre nom|اسمك/).fill('Test Guest');
  await page.locator('input[type="email"]').fill('guest@example.test');
  await page.getByRole('button', { name: /Confirmer|تأكيد/ }).click();
}

function checkInButton(page: Page) {
  return page.getByRole('button', {
    name: /Confirmer ma présence|Réessayer|تأكيد الحضور|إعادة المحاولة/,
  });
}

test('check-in button appears only while the guest is waiting, sends the bearer and a stable operationId, and shows success', async ({
  page,
}) => {
  await mockBooking(page);
  await mockWaitingStatus(page);

  let capturedAuth = '';
  let capturedBody: { operationId?: unknown } = {};
  await page.route(CHECK_IN_URL, async (route) => {
    capturedAuth = route.request().headers()['authorization'] ?? '';
    capturedBody = route.request().postDataJSON() as { operationId?: unknown };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'checked_in', reconciled: false }),
    });
  });

  await submitBookingForm(page);
  await expect(page.getByText(/en attente/)).toBeVisible();

  const button = checkInButton(page);
  await expect(button).toBeVisible();
  await button.click();

  await expect(page.getByText('Votre présence a été confirmée.')).toBeVisible();
  expect(capturedAuth).toBe(`Bearer ${BEARER}`);
  expect(typeof capturedBody.operationId).toBe('string');
  expect((capturedBody.operationId as string).length).toBeGreaterThan(0);

  expect(await page.locator('body').innerText()).not.toContain(BEARER);
  expect(page.url()).not.toContain(BEARER);
  expect(
    await page.evaluate(() => [
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ]),
  ).not.toContain(BEARER);
});

test('a reconciled replay shows the already-confirmed message instead of the fresh-success message', async ({
  page,
}) => {
  await mockBooking(page);
  await mockWaitingStatus(page);
  await page.route(CHECK_IN_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'checked_in', reconciled: true }),
    });
  });

  await submitBookingForm(page);
  await checkInButton(page).click();

  await expect(
    page.getByText('Votre présence était déjà confirmée.'),
  ).toBeVisible();
});

test('a generic rejection is shown without exposing the underlying reason, and a fresh attempt starts a new operationId', async ({
  page,
}) => {
  await mockBooking(page);
  await mockWaitingStatus(page);

  const seenOperationIds: string[] = [];
  let attempt = 0;
  await page.route(CHECK_IN_URL, async (route) => {
    attempt += 1;
    const body = route.request().postDataJSON() as { operationId: string };
    seenOperationIds.push(body.operationId);
    if (attempt === 1) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'guest_check_in_unavailable' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'checked_in', reconciled: false }),
    });
  });

  await submitBookingForm(page);
  await checkInButton(page).click();

  await expect(
    page.getByText('Impossible de confirmer votre présence pour le moment.'),
  ).toBeVisible();
  expect(page.getByText('guest_check_in_unavailable')).toHaveCount(0);

  await checkInButton(page).click();
  await expect(page.getByText('Votre présence a été confirmée.')).toBeVisible();

  expect(attempt).toBe(2);
  expect(seenOperationIds[1]).not.toBe(seenOperationIds[0]);
});

test('a transient failure keeps the same operationId across a manual retry and disables the button while pending', async ({
  page,
}) => {
  await mockBooking(page);
  await mockWaitingStatus(page);

  const seenOperationIds: string[] = [];
  let attempt = 0;
  const markFirstStartedHolder: { current: (() => void) | null } = {
    current: null,
  };
  const releaseFirstResponseHolder: { current: (() => void) | null } = {
    current: null,
  };
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStartedHolder.current = resolve;
  });
  const firstResponseReleased = new Promise<void>((resolve) => {
    releaseFirstResponseHolder.current = resolve;
  });
  await page.route(CHECK_IN_URL, async (route) => {
    attempt += 1;
    const body = route.request().postDataJSON() as { operationId: string };
    seenOperationIds.push(body.operationId);
    if (attempt === 1) {
      markFirstStartedHolder.current?.();
      await firstResponseReleased;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'temporarily_unavailable' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'checked_in', reconciled: false }),
    });
  });

  await submitBookingForm(page);
  const statusRegion = page.getByRole('status');
  await checkInButton(page).click();
  await firstStarted;
  // The button's accessible name switches to the pending label while
  // disabled, so re-query by role within the status region rather than
  // reusing a name-scoped locator that no longer matches.
  await expect(statusRegion.getByRole('button')).toBeDisabled();
  releaseFirstResponseHolder.current?.();

  await expect(
    page.getByText('La confirmation a échoué. Veuillez réessayer.'),
  ).toBeVisible();

  const retryButton = page.getByRole('button', { name: 'Réessayer' });
  await retryButton.click();
  await expect(page.getByText('Votre présence a été confirmée.')).toBeVisible();

  expect(attempt).toBe(2);
  expect(seenOperationIds[1]).toBe(seenOperationIds[0]);
});

test('Arabic renders the check-in button and success message with RTL parity', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'ar-DZ' });
  });
  await mockBooking(page);
  await mockWaitingStatus(page);
  await page.route(CHECK_IN_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'checked_in', reconciled: false }),
    });
  });

  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel('اسمك').fill('Test Guest');
  await page.locator('input[type="email"]').fill('guest@example.test');
  await page.getByRole('button', { name: 'تأكيد الحجز' }).click();
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();

  const button = page.getByRole('button', { name: 'تأكيد الحضور' });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByText('تم تأكيد حضورك.')).toBeVisible();
});

test('the check-in button does not appear once the guest is already checked in', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'checked_in',
      }),
    });
  });

  await submitBookingForm(page);
  await expect(page.getByText(/enregistré/)).toBeVisible();
  await expect(checkInButton(page)).toHaveCount(0);
});

test('a stalled check-in request times out into the transient state and a retry reuses the same operationId', async ({
  page,
}) => {
  await mockBooking(page);
  await mockWaitingStatus(page);

  const seenOperationIds: string[] = [];
  let attempt = 0;
  await page.route(CHECK_IN_URL, async (route) => {
    attempt += 1;
    const body = route.request().postDataJSON() as { operationId: string };
    seenOperationIds.push(body.operationId);
    if (attempt === 1) {
      // Never resolves on its own; only the client's own internal request
      // timeout (via AbortController) should end it.
      await new Promise<void>(() => undefined);
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'checked_in', reconciled: false }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await checkInButton(page).click();
  await expect.poll(() => attempt).toBe(1);

  await page.clock.fastForward(10_000);
  await expect(
    page.getByText('La confirmation a échoué. Veuillez réessayer.'),
  ).toBeVisible();

  const retryButton = page.getByRole('button', { name: 'Réessayer' });
  await retryButton.click();
  await expect(page.getByText('Votre présence a été confirmée.')).toBeVisible();

  expect(attempt).toBe(2);
  expect(seenOperationIds[1]).toBe(seenOperationIds[0]);
});

test('a malformed 200 check-in response is not treated as success and a retry reuses the same operationId', async ({
  page,
}) => {
  await mockBooking(page);
  await mockWaitingStatus(page);

  const seenOperationIds: string[] = [];
  let attempt = 0;
  await page.route(CHECK_IN_URL, async (route) => {
    attempt += 1;
    const body = route.request().postDataJSON() as { operationId: string };
    seenOperationIds.push(body.operationId);
    if (attempt === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ state: 'other', reconciled: 'yes' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'checked_in', reconciled: false }),
    });
  });

  await submitBookingForm(page);
  await checkInButton(page).click();

  await expect(
    page.getByText('La confirmation a échoué. Veuillez réessayer.'),
  ).toBeVisible();
  await expect(page.getByText('Votre présence a été confirmée.')).toHaveCount(
    0,
  );

  const retryButton = page.getByRole('button', { name: 'Réessayer' });
  await retryButton.click();
  await expect(page.getByText('Votre présence a été confirmée.')).toBeVisible();

  expect(attempt).toBe(2);
  expect(seenOperationIds[1]).toBe(seenOperationIds[0]);
});
