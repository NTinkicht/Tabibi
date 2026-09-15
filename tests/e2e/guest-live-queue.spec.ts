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
  await page.getByRole('button', { name: /Confirmer|تأكيد/ }).click();
  return response;
}

test('guest live queue completes the booking-to-live handoff using only the Authorization header', async ({
  page,
}) => {
  await mockBooking(page);
  let capturedAuth = '';
  let capturedCookie = '';
  await page.route(STATUS_URL, async (route) => {
    capturedAuth = route.request().headers()['authorization'] ?? '';
    capturedCookie = route.request().headers()['cookie'] ?? '';
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
  expect(capturedAuth).toBe(`Bearer ${BEARER}`);
  expect(capturedCookie).not.toContain('tabibi_guest');

  expect(await page.locator('body').innerText()).not.toContain(BEARER);
  expect(page.url()).not.toContain(BEARER);
  expect(
    await page.evaluate(() => [
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ]),
  ).not.toContain(BEARER);
  expect(response?.headers()['cache-control']).toContain('no-store');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
});

test('booking failure shows a generic message and never reaches the live view', async ({
  page,
}) => {
  await page.route(BOOKING_URL, async (route) => {
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'rejected', requestId: 'r1' }),
    });
  });

  await submitBookingForm(page);
  await expect(page.getByText(/indisponible|غير متاح/)).toBeVisible();
  await expect(page.getByText('G-042')).toHaveCount(0);
});

test('a rejected live-queue-status response enters the generic unavailable state', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'rejected', requestId: 'r1' }),
    });
  });

  await submitBookingForm(page);
  await expect(
    page.getByText(/Accès indisponible|الوصول غير متاح/),
  ).toBeVisible();
});

test('reload after reaching the live view returns to the booking form, proving no persisted bearer recovery', async ({
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

  await page.reload();
  await expect(
    page.getByRole('button', { name: /Confirmer|تأكيد/ }),
  ).toBeVisible();
  await expect(page.getByText('G-042')).toHaveCount(0);
});

test('a terminal booking/queue state stops polling permanently', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'completed',
        queueState: 'completed',
      }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await expect(
    page.getByRole('heading', { name: /Statut de la visite|حالة الزيارة/ }),
  ).toBeVisible();
  expect(requests).toBe(1);

  await page.clock.fastForward(120_000);
  expect(requests).toBe(1);
});

test('active states keep polling on the 30-second cadence', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
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
  await expect(page.getByText(/en attente/)).toBeVisible();
  expect(requests).toBe(1);

  await page.clock.fastForward(29_000);
  expect(requests).toBe(1);
  await page.clock.fastForward(2_000);
  await expect.poll(() => requests).toBe(2);
});

test('transient failures retry on the 5/15/30/60-second sequence and reset on success', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (requests <= 2) {
      await route.fulfill({ status: 503, body: '' });
      return;
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
  await expect.poll(() => requests).toBe(1);

  await page.clock.fastForward(4_000);
  expect(requests).toBe(1);
  await page.clock.fastForward(2_000);
  await expect.poll(() => requests).toBe(2);

  await page.clock.fastForward(14_000);
  expect(requests).toBe(2);
  await page.clock.fastForward(2_000);
  await expect.poll(() => requests).toBe(3);
  await expect(page.getByText(/en attente/)).toBeVisible();
});

test('a stalled response triggers the internal 10-second request timeout and retries', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (requests === 1) {
      // Never resolves on its own; only the client's own internal
      // REQUEST_TIMEOUT_MS abort ends it.
      await new Promise<void>(() => undefined);
      return;
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
  await expect.poll(() => requests).toBe(1);

  await page.clock.fastForward(9_000);
  expect(requests).toBe(1);
  await page.clock.fastForward(1_000);
  // The internal timeout fires at exactly 10s and schedules the first
  // transient-failure retry at its 5s base delay.
  await page.clock.fastForward(4_000);
  expect(requests).toBe(1);
  await page.clock.fastForward(1_000);
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByText(/en attente/)).toBeVisible();
});

test('a Retry-After header lengthens the retry delay beyond the base backoff', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({
        status: 503,
        headers: { 'retry-after': '20' },
        body: '',
      });
      return;
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
  await expect.poll(() => requests).toBe(1);

  // Retry-After: 20s exceeds the 5s base delay for the first failure, so it
  // must win: no retry before 20s, one shortly after.
  await page.clock.fastForward(19_000);
  expect(requests).toBe(1);
  await page.clock.fastForward(1_000);
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByText(/en attente/)).toBeVisible();
});

test('a Retry-After header is capped at 300 seconds', async ({ page }) => {
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({
        status: 503,
        headers: { 'retry-after': '9999' },
        body: '',
      });
      return;
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
  await expect.poll(() => requests).toBe(1);

  // Retry-After: 9999s must be clamped to the 300s cap, not honored as-is.
  await page.clock.fastForward(299_000);
  expect(requests).toBe(1);
  await page.clock.fastForward(1_000);
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByText(/en attente/)).toBeVisible();
});

test('each transient retry delay honors its exact 5/15/30/60-second lower bound', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (requests <= 4) {
      await route.fulfill({ status: 503, body: '' });
      return;
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
  await expect.poll(() => requests).toBe(1);

  await page.clock.fastForward(4_000);
  expect(requests).toBe(1);
  await page.clock.fastForward(1_000);
  await expect.poll(() => requests).toBe(2);

  await page.clock.fastForward(14_000);
  expect(requests).toBe(2);
  await page.clock.fastForward(1_000);
  await expect.poll(() => requests).toBe(3);

  await page.clock.fastForward(29_000);
  expect(requests).toBe(3);
  await page.clock.fastForward(1_000);
  await expect.poll(() => requests).toBe(4);

  await page.clock.fastForward(59_000);
  expect(requests).toBe(4);
  await page.clock.fastForward(1_000);
  await expect.poll(() => requests).toBe(5);
  await expect(page.getByText(/en attente/)).toBeVisible();
});

test('exhausts after five consecutive transient failures and a manual retry issues a fresh request', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  let allowSuccess = false;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (!allowSuccess) {
      await route.fulfill({ status: 503, body: '' });
      return;
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
  await expect.poll(() => requests).toBe(1);
  await page.clock.fastForward(6_000);
  await expect.poll(() => requests).toBe(2);
  await page.clock.fastForward(16_000);
  await expect.poll(() => requests).toBe(3);
  await page.clock.fastForward(31_000);
  await expect.poll(() => requests).toBe(4);
  await page.clock.fastForward(61_000);
  await expect.poll(() => requests).toBe(5);

  await expect(
    page.getByText(/Connexion interrompue|انقطع الاتصال/),
  ).toBeVisible();

  allowSuccess = true;
  await page.getByRole('button', { name: /maintenant|الآن/ }).click();
  await expect.poll(() => requests).toBe(6);
  await expect(page.getByText(/en attente/)).toBeVisible();
});

test('hidden view does not start new polls and resumes with exactly one immediate refresh', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    });
  });

  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    Object.defineProperty(window, '__setLiveQueueHiddenForTest', {
      configurable: true,
      value: (value: boolean) => {
        hidden = value;
        document.dispatchEvent(new Event('visibilitychange'));
      },
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await expect.poll(() => requests).toBe(1);

  await page.evaluate(() => {
    (
      window as typeof window & {
        __setLiveQueueHiddenForTest: (value: boolean) => void;
      }
    ).__setLiveQueueHiddenForTest(true);
  });
  await page.clock.fastForward(90_000);
  expect(requests).toBe(1);

  await page.evaluate(() => {
    (
      window as typeof window & {
        __setLiveQueueHiddenForTest: (value: boolean) => void;
      }
    ).__setLiveQueueHiddenForTest(false);
  });
  await expect.poll(() => requests).toBe(2);
  await page.clock.fastForward(1_000);
  expect(requests).toBe(2);
});

test('Arabic renders RTL and French renders LTR with equivalent state semantics', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'ar-DZ' });
  });
  await page.goto('/guest/live-queue/test-selection-ref');
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.getByText('احجز زيارتك')).toBeVisible();

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
  await page.getByLabel('اسمك').fill('Test Guest');
  await page.getByRole('button', { name: 'تأكيد الحجز' }).click();
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.getByText('في الانتظار')).toBeVisible();
});

test('reuses the same idempotency key across a retry after a failed submission', async ({
  page,
}) => {
  const seenKeys: string[] = [];
  let attempt = 0;
  await page.route(BOOKING_URL, async (route) => {
    attempt += 1;
    seenKeys.push(route.request().headers()['idempotency-key'] ?? '');
    if (attempt === 1) {
      await route.fulfill({ status: 503, body: '' });
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

  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel(/Votre nom|اسمك/).fill('Test Guest');
  const submit = page.getByRole('button', { name: /Confirmer|تأكيد/ });
  await submit.click();
  await expect(page.getByText(/indisponible|غير متاح/)).toBeVisible();
  await submit.click();
  await expect(page.getByText('G-042')).toBeVisible();

  expect(attempt).toBe(2);
  expect(seenKeys[0]).not.toBe('');
  expect(seenKeys[1]).toBe(seenKeys[0]);
});

test('a terminal queue state displays even when the booking state alone is not terminal', async ({
  page,
}) => {
  await mockBooking(page);
  await page.route(STATUS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'cancelled',
      }),
    });
  });

  await submitBookingForm(page);
  await expect(
    page.getByRole('heading', { name: /Statut de la visite|حالة الزيارة/ }),
  ).toBeVisible();
  await expect(page.getByText('confirmée')).toBeVisible();
  await expect(page.getByText('annulé')).toBeVisible();
});

test('a booking-only terminal state (no_show) stops polling and renders both fields', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'no_show',
        queueState: 'waiting',
      }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await expect(
    page.getByRole('heading', { name: /Statut de la visite|حالة الزيارة/ }),
  ).toBeVisible();
  await expect(page.getByText('absent')).toBeVisible();
  await expect(page.getByText('en attente')).toBeVisible();
  expect(requests).toBe(1);

  await page.clock.fastForward(120_000);
  expect(requests).toBe(1);
});

test('a booking-only terminal state (completed) stops polling', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'completed',
        queueState: 'waiting',
      }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await expect(
    page.getByRole('heading', { name: /Statut de la visite|حالة الزيارة/ }),
  ).toBeVisible();
  await expect(page.getByText('terminée')).toBeVisible();
  await expect(page.getByText('en attente')).toBeVisible();
  expect(requests).toBe(1);

  await page.clock.fastForward(120_000);
  expect(requests).toBe(1);
});

test('a booking-only terminal state (cancelled) stops polling', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'cancelled',
        queueState: 'waiting',
      }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await expect(
    page.getByRole('heading', { name: /Statut de la visite|حالة الزيارة/ }),
  ).toBeVisible();
  await expect(page.getByText('annulée')).toBeVisible();
  await expect(page.getByText('en attente')).toBeVisible();
  expect(requests).toBe(1);

  await page.clock.fastForward(120_000);
  expect(requests).toBe(1);
});

test('a queue-only terminal state (no_show) stops polling', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'no_show',
      }),
    });
  });

  await page.clock.install();
  await submitBookingForm(page);
  await expect(
    page.getByRole('heading', { name: /Statut de la visite|حالة الزيارة/ }),
  ).toBeVisible();
  await expect(page.getByText('confirmée')).toBeVisible();
  await expect(page.getByText('absent')).toBeVisible();
  expect(requests).toBe(1);

  await page.clock.fastForward(120_000);
  expect(requests).toBe(1);
});

test('aborts the in-flight request on hide so a stale response cannot resurrect polling after exhaustion', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  const releaseFirstHolder: { current: (() => void) | null } = {
    current: null,
  };
  const startedHolder: { current: (() => void) | null } = { current: null };
  const firstRequestStarted = new Promise<void>((resolve) => {
    startedHolder.current = resolve;
  });
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (requests === 1) {
      startedHolder.current?.();
      await new Promise<void>((resolve) => {
        releaseFirstHolder.current = resolve;
      });
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            bookingState: 'confirmed',
            queueState: 'waiting',
          }),
        });
      } catch {
        // The client aborted this request on hide; fulfilling it afterward
        // is expected to fail and is not part of what this test asserts.
      }
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'checked_in',
      }),
    });
  });

  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    Object.defineProperty(window, '__setLiveQueueHiddenForTest', {
      configurable: true,
      value: (value: boolean) => {
        hidden = value;
        document.dispatchEvent(new Event('visibilitychange'));
      },
    });
  });

  await submitBookingForm(page);
  await firstRequestStarted;

  await page.evaluate(() => {
    (
      window as typeof window & {
        __setLiveQueueHiddenForTest: (value: boolean) => void;
      }
    ).__setLiveQueueHiddenForTest(true);
  });
  await page.evaluate(() => {
    (
      window as typeof window & {
        __setLiveQueueHiddenForTest: (value: boolean) => void;
      }
    ).__setLiveQueueHiddenForTest(false);
  });
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByText(/enregistré/)).toBeVisible();

  releaseFirstHolder.current?.();
  await page.waitForTimeout(200);
  await expect(page.getByText(/enregistré/)).toBeVisible();
  expect(requests).toBe(2);
});

test('recovers automatic polling when visibility returns before a hide-triggered abort settles', async ({
  page,
}) => {
  await mockBooking(page);
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (requests === 1) {
      // Never resolves on its own; only the client's own abort ends it.
      await new Promise<void>(() => undefined);
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'checked_in',
      }),
    });
  });

  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    Object.defineProperty(window, '__setLiveQueueHiddenForTest', {
      configurable: true,
      value: (value: boolean) => {
        hidden = value;
        document.dispatchEvent(new Event('visibilitychange'));
      },
    });
  });

  await submitBookingForm(page);
  await expect.poll(() => requests).toBe(1);

  // Flip hidden -> visible back-to-back synchronously, so the visible
  // handler runs while the first request is still `inFlight` (its
  // abort-triggered rejection has not been processed yet), reproducing the
  // race where the immediate-refresh check saw inFlight=true and skipped.
  await page.evaluate(() => {
    const w = window as typeof window & {
      __setLiveQueueHiddenForTest: (value: boolean) => void;
    };
    w.__setLiveQueueHiddenForTest(true);
    w.__setLiveQueueHiddenForTest(false);
  });

  await expect.poll(() => requests).toBe(2);
  await expect(page.getByText(/enregistré/)).toBeVisible();
});
