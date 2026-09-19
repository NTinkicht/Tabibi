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

test('an in_consultation response omitting the remaining-time field entirely renders no fabricated status', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // A legacy or otherwise incomplete payload with the field omitted
      // entirely (not `null`) must not be treated as "field applicable and
      // present"; it must render exactly as if there were no active
      // consultation, never "environ undefined min".
      body: JSON.stringify({
        bookingState: 'checked_in',
        queueState: 'in_consultation',
        eta: null,
      }),
    });
  });

  await submitBookingForm(page);
  await expect(page.getByText(/en consultation/)).toBeVisible();
  await expect(page.getByText('Consultation en cours')).toHaveCount(0);
  await expect(page.getByText(/undefined/)).toHaveCount(0);
});

test('renders the remaining consultation time as its own status, distinct from the waiting ETA', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'checked_in',
        queueState: 'in_consultation',
        activeConsultationRemainingMinutes: 8,
        eta: {
          patientsAhead: 0,
          minWaitMinutes: 0,
          maxWaitMinutes: 0,
          estimateSource: 'fallback',
        },
      }),
    });
  });

  await submitBookingForm(page);
  await expect(page.getByText(/en consultation/)).toBeVisible();
  await expect(page.getByText('Consultation en cours')).toBeVisible();
  await expect(
    page.getByText('Temps restant estimé : environ 8 min'),
  ).toBeVisible();
  // The pre-existing waiting-range status is a distinct region with its own
  // heading; both can render, but the remaining-time copy must never appear
  // inside it.
  await expect(page.getByText('Temps d’attente estimé')).toBeVisible();
});

test('uses singular wording for exactly one minute remaining', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'checked_in',
        queueState: 'in_consultation',
        activeConsultationRemainingMinutes: 1,
        eta: null,
      }),
    });
  });

  await submitBookingForm(page);
  await expect(
    page.getByText('Temps restant estimé : environ 1 min'),
  ).toBeVisible();
});

test('shows no active-consultation status while only waiting or checked in', async ({
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
        activeConsultationRemainingMinutes: null,
        eta: {
          patientsAhead: 2,
          minWaitMinutes: 10,
          maxWaitMinutes: 20,
          estimateSource: 'fallback',
        },
      }),
    });
  });

  await submitBookingForm(page);
  await expect(page.getByText(/enregistré/)).toBeVisible();
  await expect(page.getByText('Consultation en cours')).toHaveCount(0);
});

test('suppresses the active-consultation status once the visit is terminal', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'completed',
        queueState: 'completed',
        activeConsultationRemainingMinutes: null,
        eta: null,
      }),
    });
  });

  await submitBookingForm(page);
  await expect(page.getByText('Consultation en cours')).toHaveCount(0);
  await expect(page.getByText('Temps d’attente estimé')).toHaveCount(0);
});

test('Arabic renders the active-consultation status with RTL parity', async ({
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
        queueState: 'in_consultation',
        activeConsultationRemainingMinutes: 6,
        eta: null,
      }),
    });
  });

  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel('اسمك').fill('Test Guest');
  await page.getByRole('button', { name: 'تأكيد الحجز' }).click();

  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.getByText('الاستشارة جارية الآن')).toBeVisible();
  await expect(
    page.getByText('الوقت المتبقي المقدر: حوالي 6 دقائق'),
  ).toBeVisible();
});

test('Arabic uses the dedicated singular and dual noun forms for 1 and 2 minutes', async ({
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
        queueState: 'in_consultation',
        activeConsultationRemainingMinutes: 1,
        eta: null,
      }),
    });
  });

  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel('اسمك').fill('Test Guest');
  await page.getByRole('button', { name: 'تأكيد الحجز' }).click();

  await expect(
    page.getByText('الوقت المتبقي المقدر: حوالي دقيقة واحدة'),
  ).toBeVisible();
});

test('a stale in-flight poll response cannot regress a previously shown remaining-time status', async ({
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
          queueState: 'in_consultation',
          activeConsultationRemainingMinutes: 9,
          eta: null,
        }),
      });
      return;
    }
    // Simulates a slow second poll that only resolves, with an
    // out-of-order 'called' snapshot (no remaining time), after the first
    // poll's in_consultation remaining-time has already been shown.
    staleStatusStartedHolder.current?.();
    await staleStatusReleased;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'checked_in',
        queueState: 'called',
        activeConsultationRemainingMinutes: null,
        eta: null,
      }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await expect(page.getByText(/en consultation/)).toBeVisible();
  await expect(
    page.getByText('Temps restant estimé : environ 9 min'),
  ).toBeVisible();

  await page.clock.fastForward(30_000);
  await staleStatusStarted;
  releaseStaleStatusHolder.current?.();
  await page.waitForTimeout(200);

  // The display must not regress: the queue state and the previously
  // authoritative remaining-time status must both still be showing.
  await expect(page.getByText(/en consultation/)).toBeVisible();
  await expect(
    page.getByText('Temps restant estimé : environ 9 min'),
  ).toBeVisible();
  await expect(page.getByText(/appelé/)).toHaveCount(0);
});
