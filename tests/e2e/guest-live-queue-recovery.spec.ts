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

async function submitBookingForm(page: Page, name = 'Test Guest') {
  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel(/Votre nom|اسمك/).fill(name);
  await page.getByRole('button', { name: /Confirmer|تأكيد/ }).click();
}

function checkInButton(page: Page) {
  return page.getByRole('button', {
    name: /Confirmer ma présence|Réessayer|تأكيد الحضور|إعادة المحاولة/,
  });
}

test('reload after a completed check-in returns to the plain booking form without leaking that a booking or check-in exists', async ({
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
  await page.route(CHECK_IN_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'checked_in', reconciled: false }),
    });
  });

  await submitBookingForm(page);
  await checkInButton(page).click();
  await expect(page.getByText('Votre présence a été confirmée.')).toBeVisible();

  await page.reload();

  await expect(page.getByRole('button', { name: /Confirmer/ })).toBeVisible();
  await expect(page.getByText('G-042')).toHaveCount(0);
  await expect(page.getByText(/enregistré|confirmée/)).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(BEARER);
  expect(page.url()).not.toContain(BEARER);
  expect(
    await page.evaluate(() => [
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ]),
  ).not.toContain(BEARER);
});

test('a fresh authorized re-entry (a successful booking retry) immediately reflects an already-completed check-in from server state, with no check-in prompt shown', async ({
  page,
}) => {
  let bookingAttempt = 0;
  await page.route(BOOKING_URL, async (route) => {
    bookingAttempt += 1;
    if (bookingAttempt === 1) {
      // Simulate an ambiguous transport failure: the client never sees this
      // response, so it retries with the same idempotency key per the
      // existing WU64 retry contract.
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        serviceDate: '2099-05-15',
        startsAt: '2099-05-15T08:00:00.000Z',
        endsAt: '2099-05-15T09:00:00.000Z',
        queueLabel: 'G-042',
        guestBearer: BEARER,
        guestAccessExpiresAt: '2099-05-16T08:00:00.000Z',
      }),
    });
  });
  // The booking already reflects a completed check-in by the time this
  // fresh, authorized re-entry's first status poll runs -- authoritative
  // server state, not anything the client remembered.
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

  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel(/Votre nom|اسمك/).fill('Test Guest');
  const submit = page.getByRole('button', { name: /Confirmer/ });
  await submit.click();
  await expect(page.getByText(/indisponible/)).toBeVisible();
  await submit.click();

  await expect(page.getByText(/enregistré/)).toBeVisible();
  await expect(checkInButton(page)).toHaveCount(0);
  expect(bookingAttempt).toBe(2);
});

test('a stale in-flight poll response that predates a successful check-in cannot regress the display back to waiting', async ({
  page,
}) => {
  await mockBooking(page);

  let statusAttempt = 0;
  const releaseStaleStatusHolder: { current: (() => void) | null } = {
    current: null,
  };
  const staleStatusReleased = new Promise<void>((resolve) => {
    releaseStaleStatusHolder.current = resolve;
  });
  const staleStatusStartedHolder: { current: (() => void) | null } = {
    current: null,
  };
  const staleStatusStarted = new Promise<void>((resolve) => {
    staleStatusStartedHolder.current = resolve;
  });

  await page.route(STATUS_URL, async (route) => {
    statusAttempt += 1;
    if (statusAttempt === 1) {
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
    // The second poll (triggered by the 30s cadence below) is held open to
    // simulate a slow response that only resolves, with stale data, after
    // the check-in below has already completed.
    staleStatusStartedHolder.current?.();
    await staleStatusReleased;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    });
  });
  await page.route(CHECK_IN_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'checked_in', reconciled: false }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await expect(page.getByText(/en attente/)).toBeVisible();

  // Advance to the next poll cadence so the second (stale) request starts.
  await page.clock.fastForward(30_000);
  await staleStatusStarted;

  // While that stale poll is still in flight, check in successfully.
  await checkInButton(page).click();
  await expect(page.getByText('Votre présence a été confirmée.')).toBeVisible();
  await expect(page.getByText(/enregistré/)).toBeVisible();

  // Now let the stale poll resolve with its outdated 'waiting' snapshot.
  releaseStaleStatusHolder.current?.();
  await page.waitForTimeout(200);

  // The display must not regress: the success message and the checked-in
  // status must still be showing, and the check-in button must not
  // reappear.
  await expect(page.getByText('Votre présence a été confirmée.')).toBeVisible();
  await expect(page.getByText(/enregistré/)).toBeVisible();
  await expect(checkInButton(page)).toHaveCount(0);
  await expect(page.getByText(/en attente/)).toHaveCount(0);
});

test('Arabic renders the stale-response suppression and reload-recovery behavior with RTL parity', async ({
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
  await page.route(CHECK_IN_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'checked_in', reconciled: false }),
    });
  });

  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel('اسمك').fill('Test Guest');
  await page.getByRole('button', { name: 'تأكيد الحجز' }).click();
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();

  await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
  await expect(page.getByText('تم تأكيد حضورك.')).toBeVisible();

  await page.reload();
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'تأكيد الحجز' })).toBeVisible();
  await expect(page.getByText('تم تأكيد حضورك.')).toHaveCount(0);
});
