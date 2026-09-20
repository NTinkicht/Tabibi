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
  const explainer = page.getByRole('link', {
    name: 'Pourquoi ces estimations changent',
  });
  await expect(explainer).toHaveAttribute(
    'href',
    '/guest/eta-explained?lang=fr',
  );
  await expect(explainer).toHaveAttribute('target', '_blank');
  await expect(explainer).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(explainer).toHaveAttribute(
    'aria-describedby',
    'tabibi-wait-eta-explainer-hint',
  );
  await expect(page.locator('#tabibi-wait-eta-explainer-hint')).toHaveText(
    '(s’ouvre dans un nouvel onglet)',
  );
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
          delayStatus: 'declared',
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
  await expect(
    page.getByText('تشمل هذه المدة المقدرة تأخر الطبيب.'),
  ).toBeVisible();
  const explainer = page.getByRole('link', {
    name: 'لماذا تتغير هذه التقديرات',
  });
  await expect(explainer).toHaveAttribute(
    'href',
    '/guest/eta-explained?lang=ar',
  );
  await expect(explainer).toHaveAttribute('target', '_blank');
  await expect(explainer).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(explainer).toHaveAttribute(
    'aria-describedby',
    'tabibi-wait-eta-explainer-hint',
  );
  await expect(page.locator('#tabibi-wait-eta-explainer-hint')).toHaveText(
    '(يُفتح في علامة تبويب جديدة)',
  );
});

test('French delay notice follows declared, updated, and cleared snapshots', async ({
  page,
}) => {
  await mockBooking(page);
  let attempt = 0;
  await page.route(STATUS_URL, async (route) => {
    attempt += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'checked_in',
        queueState: 'checked_in',
        eta: {
          patientsAhead: 1,
          minWaitMinutes: attempt === 1 ? 20 : attempt === 2 ? 35 : 10,
          maxWaitMinutes: attempt === 1 ? 30 : attempt === 2 ? 45 : 20,
          estimateSource: 'fallback',
          delayStatus: attempt < 3 ? 'declared' : null,
        },
      }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  const notice = page.getByText(
    'Un retard du médecin est pris en compte dans cette estimation.',
  );
  await expect(notice).toBeVisible();
  await expect(page.getByText('Environ 20–30 min')).toBeVisible();

  await page.clock.fastForward(30_000);
  await expect(page.getByText('Environ 35–45 min')).toBeVisible();
  await expect(notice).toBeVisible();

  await page.clock.fastForward(30_000);
  await expect(page.getByText('Environ 10–20 min')).toBeVisible();
  await expect(notice).toHaveCount(0);
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
            delayStatus: 'declared',
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
  await expect(
    page.getByText(
      'Un retard du médecin est pris en compte dans cette estimation.',
    ),
  ).toBeVisible();

  await page.clock.fastForward(30_000);
  await staleStatusStarted;
  releaseStaleStatusHolder.current?.();
  await page.waitForTimeout(200);

  // The display must not regress: the queue state and the previously
  // authoritative ETA must both still be showing.
  await expect(page.getByText(/enregistré/)).toBeVisible();
  await expect(page.getByText('1 personne devant vous')).toBeVisible();
  await expect(page.getByText('Environ 5–10 min')).toBeVisible();
  await expect(
    page.getByText(
      'Un retard du médecin est pris en compte dans cette estimation.',
    ),
  ).toBeVisible();
  await expect(page.getByText(/en attente/)).toHaveCount(0);
});

test('French renders pause instead of ETA, preserves it across a stale regression, and restores ETA on resume', async ({
  page,
}) => {
  await mockBooking(page);
  let attempt = 0;
  await page.route(STATUS_URL, async (route) => {
    attempt += 1;
    const body =
      attempt === 1
        ? {
            bookingState: 'checked_in',
            queueState: 'checked_in',
            pauseStatus: 'paused',
            activeConsultationRemainingMinutes: null,
            eta: null,
          }
        : attempt === 2
          ? {
              bookingState: 'confirmed',
              queueState: 'waiting',
              pauseStatus: null,
              activeConsultationRemainingMinutes: null,
              eta: null,
            }
          : {
              bookingState: 'checked_in',
              queueState: 'checked_in',
              pauseStatus: null,
              activeConsultationRemainingMinutes: null,
              eta: {
                patientsAhead: 1,
                minWaitMinutes: 5,
                maxWaitMinutes: 10,
                estimateSource: 'fallback',
              },
            };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await expect(page.getByText('File temporairement en pause')).toBeVisible();
  await expect(page.getByText('Temps d’attente estimé')).toHaveCount(0);

  await page.clock.fastForward(30_000);
  await expect(page.getByText('File temporairement en pause')).toBeVisible();
  await expect(page.getByText(/en attente/)).toHaveCount(0);

  await page.clock.fastForward(30_000);
  await expect(page.getByText('Environ 5–10 min')).toBeVisible();
  await expect(page.getByText('File temporairement en pause')).toHaveCount(0);
});

test('Arabic renders an accessible RTL pause status without false precision', async ({
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
        pauseStatus: 'paused',
        activeConsultationRemainingMinutes: null,
        eta: null,
      }),
    });
  });

  await submitBookingForm(page);
  const shell = page.locator('section[lang="ar"][dir="rtl"]');
  await expect(shell).toBeVisible();
  await expect(
    shell.getByRole('status').filter({
      has: page.getByRole('heading', {
        name: 'قائمة الانتظار متوقفة مؤقتًا',
      }),
    }),
  ).toBeVisible();
  await expect(page.getByText('وقت الانتظار المقدر')).toHaveCount(0);
  await expect(page.getByText('الاستشارة جارية الآن')).toHaveCount(0);
});

test('a stale clamped poll response cannot resurrect a cleared pause status', async ({
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
      // Authoritatively resumed: pauseStatus is explicitly null, not absent.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          bookingState: 'checked_in',
          queueState: 'checked_in',
          pauseStatus: null,
          activeConsultationRemainingMinutes: null,
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
    // The second poll is held open to simulate a slow response that only
    // resolves, with an out-of-order stale 'waiting'/paused snapshot, after
    // the resumed (pauseStatus: null) state has already been authoritatively
    // displayed. clampQueueState holds queueState at the 'checked_in' floor,
    // so this pauseStatus must not resurrect the pause banner either.
    staleStatusStartedHolder.current?.();
    await staleStatusReleased;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
        pauseStatus: 'paused',
        activeConsultationRemainingMinutes: null,
        eta: null,
      }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await expect(page.getByText(/enregistré/)).toBeVisible();
  await expect(page.getByText('Environ 5–10 min')).toBeVisible();
  await expect(page.getByText('File temporairement en pause')).toHaveCount(0);

  await page.clock.fastForward(30_000);
  await staleStatusStarted;
  releaseStaleStatusHolder.current?.();
  await page.waitForTimeout(200);

  // The display must not regress: the resumed ETA must still be showing and
  // the pause banner must not have reappeared from the stale response.
  await expect(page.getByText(/enregistré/)).toBeVisible();
  await expect(page.getByText('Environ 5–10 min')).toBeVisible();
  await expect(page.getByText('File temporairement en pause')).toHaveCount(0);
  await expect(page.getByText(/en attente/)).toHaveCount(0);
});
