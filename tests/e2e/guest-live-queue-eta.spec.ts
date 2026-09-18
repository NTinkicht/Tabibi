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

async function submitBookingForm(
  page: Page,
  path = '/guest/live-queue/test-selection-ref',
) {
  await page.goto(path);
  await page.getByLabel(/Votre nom|اسمك/).fill('Test Guest');
  await page.getByRole('button', { name: /Confirmer|تأكيد/ }).click();
}

test('renders patientsAhead and the estimated wait range once checked in', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'checked_in',
        queueState: 'checked_in',
        eta: {
          patientsAhead: 2,
          minWaitMinutes: 10,
          maxWaitMinutes: 20,
          estimateSource: 'observed_median',
          summary: {
            midpointMinutes: 15,
            uncertaintyWidthMinutes: 10,
            confidence: 'medium',
          },
        },
      }),
    });
  });

  await submitBookingForm(page);
  await expect(page.getByText(/enregistré/)).toBeVisible();
  await expect(page.getByText('Temps d’attente estimé')).toBeVisible();
  await expect(page.getByText('2 personnes devant vous')).toBeVisible();
  await expect(page.getByText('Environ 10–20 min')).toBeVisible();
  await expect(
    page.getByText('Confiance de l’estimation: moyenne'),
  ).toBeVisible();
});

test('shows a single-value wait range and next-in-line copy when patientsAhead is zero', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'checked_in',
        queueState: 'checked_in',
        eta: {
          patientsAhead: 0,
          minWaitMinutes: 0,
          maxWaitMinutes: 0,
          estimateSource: 'fallback',
          summary: {
            midpointMinutes: 0,
            uncertaintyWidthMinutes: 0,
            confidence: 'high',
          },
        },
      }),
    });
  });

  await submitBookingForm(page);
  await expect(page.getByText('Vous êtes le prochain')).toBeVisible();
  await expect(page.getByText('Environ 0 min')).toBeVisible();
  await expect(
    page.getByText('Confiance de l’estimation: élevée'),
  ).toBeVisible();
});

test('renders low confidence when ETA uncertainty exceeds 15 minutes', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'checked_in',
        queueState: 'checked_in',
        eta: {
          patientsAhead: 3,
          minWaitMinutes: 10,
          maxWaitMinutes: 30,
          estimateSource: 'fallback',
          summary: {
            midpointMinutes: 20,
            uncertaintyWidthMinutes: 20,
            confidence: 'low',
          },
        },
      }),
    });
  });

  await submitBookingForm(page);
  await expect(page.getByText('Environ 10–30 min')).toBeVisible();
  await expect(
    page.getByText('Confiance de l’estimation: faible'),
  ).toBeVisible();
});

test('shows no ETA section while the guest is still waiting', async ({
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
        eta: null,
      }),
    });
  });

  await submitBookingForm(page);
  await expect(page.getByText(/en attente/)).toBeVisible();
  await expect(page.getByText('Temps d’attente estimé')).toHaveCount(0);
});

test('Arabic renders the ETA section with RTL parity', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'ar-DZ' });
  });
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'checked_in',
        queueState: 'checked_in',
        eta: {
          patientsAhead: 3,
          minWaitMinutes: 15,
          maxWaitMinutes: 30,
          estimateSource: 'fallback',
          summary: {
            midpointMinutes: 22.5,
            uncertaintyWidthMinutes: 15,
            confidence: 'medium',
          },
        },
      }),
    });
  });

  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel('اسمك').fill('Test Guest');
  await page.getByRole('button', { name: 'تأكيد الحجز' }).click();

  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.getByText('وقت الانتظار المقدر')).toBeVisible();
  await expect(page.getByText('3 أشخاص أمامك')).toBeVisible();
  await expect(page.getByText('حوالي 15–30 دقيقة')).toBeVisible();
  await expect(page.getByText('ثقة التقدير: متوسطة')).toBeVisible();
});

test('Arabic uses singular wording for exactly one patient ahead', async ({
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
        bookingState: 'checked_in',
        queueState: 'checked_in',
        eta: {
          patientsAhead: 1,
          minWaitMinutes: 5,
          maxWaitMinutes: 10,
          estimateSource: 'fallback',
        },
      }),
    });
  });

  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel('اسمك').fill('Test Guest');
  await page.getByRole('button', { name: 'تأكيد الحجز' }).click();

  await expect(page.getByText('شخص واحد أمامك')).toBeVisible();
  await expect(page.getByText('1 أشخاص أمامك')).toHaveCount(0);
});

test('a stale in-flight poll response cannot regress a previously shown ETA', async ({
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
          bookingState: 'checked_in',
          queueState: 'checked_in',
          eta: {
            patientsAhead: 1,
            minWaitMinutes: 5,
            maxWaitMinutes: 10,
            estimateSource: 'fallback',
          },
        }),
      });
      return;
    }
    // The second poll (triggered by the 30s cadence below) is held open to
    // simulate a slow response that only resolves, with an out-of-order
    // stale 'waiting'/null-eta snapshot, after the first poll's checked-in
    // ETA has already been authoritatively displayed.
    staleStatusStartedHolder.current?.();
    await staleStatusReleased;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
        eta: null,
      }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await expect(page.getByText(/enregistré/)).toBeVisible();
  await expect(page.getByText('1 personne devant vous')).toBeVisible();
  await expect(page.getByText('Environ 5–10 min')).toBeVisible();

  await page.clock.fastForward(30_000);
  await staleStatusStarted;
  releaseStaleStatusHolder.current?.();
  await page.waitForTimeout(200);

  // The display must not regress: the queue state and the previously
  // authoritative ETA must both still be showing.
  await expect(page.getByText(/enregistré/)).toBeVisible();
  await expect(page.getByText('1 personne devant vous')).toBeVisible();
  await expect(page.getByText('Environ 5–10 min')).toBeVisible();
  await expect(page.getByText(/en attente/)).toHaveCount(0);
});
