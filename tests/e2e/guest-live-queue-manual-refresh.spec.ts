import { expect, test, type Page } from '@playwright/test';

const BOOKING_URL = '**/api/public/bookings';
const STATUS_URL = '**/api/public/bookings/live-queue-status';
const STREAM_URL = '**/api/public/bookings/live-queue-stream';
const BEARER = 'manual-refresh.test-bearer.signature';

async function openLiveQueue(page: Page) {
  await page.route(BOOKING_URL, (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ queueLabel: 'G-098', guestBearer: BEARER }),
    }),
  );
  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel(/Votre nom|اسمك/).fill('Test Guest');
  await page.getByRole('button', { name: /Confirmer|تأكيد/ }).click();
}

test('manual refresh uses the canonical bearer-header request without disclosure', async ({
  page,
}) => {
  const authorizations: string[] = [];
  const statusRequestUrls: string[] = [];
  await page.route(STATUS_URL, async (route) => {
    authorizations.push(route.request().headers()['authorization'] ?? '');
    statusRequestUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    });
  });

  await openLiveQueue(page);
  const refresh = page.getByRole('button', {
    name: 'Actualiser mon statut',
  });
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect.poll(() => authorizations.length).toBe(2);
  expect(authorizations).toEqual([`Bearer ${BEARER}`, `Bearer ${BEARER}`]);
  expect(statusRequestUrls).toHaveLength(2);
  for (const requestUrl of statusRequestUrls)
    expect(requestUrl).not.toContain(BEARER);
  expect(page.url()).not.toContain(BEARER);
  expect(await page.locator('body').innerText()).not.toContain(BEARER);
  expect(
    await page.evaluate(() => [
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ]),
  ).not.toContain(BEARER);
});

test('manual refresh is disabled while pending and repeated clicks do not create concurrent polls', async ({
  page,
}) => {
  let requests = 0;
  let releaseRefresh: (() => void) | undefined;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (requests === 2) {
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
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

  await openLiveQueue(page);
  const refresh = page.getByRole('button', {
    name: 'Actualiser mon statut',
  });
  await expect(refresh).toBeVisible();
  await refresh.click();
  const pending = page.getByRole('button', {
    name: 'Actualisation en cours…',
  });
  await expect(pending).toBeDisabled();
  await pending.evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => requests).toBe(2);
  releaseRefresh?.();
  await expect(refresh).toBeEnabled();
  expect(requests).toBe(2);
});

test('Arabic active view exposes an RTL refresh control and terminal state removes it', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'ar-DZ',
    });
  });
  let requests = 0;
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: requests === 1 ? 'confirmed' : 'completed',
        queueState: requests === 1 ? 'waiting' : 'completed',
      }),
    });
  });

  await openLiveQueue(page);
  const refresh = page.getByRole('button', { name: 'تحديث حالتي' });
  await expect(refresh).toBeVisible();
  await expect(page.locator('section[lang="ar"]')).toHaveAttribute(
    'dir',
    'rtl',
  );
  await refresh.click();
  await expect(refresh).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'حالة الزيارة' }),
  ).toBeVisible();
});

test('data-bearing stale view can refresh without losing guest access after transient failure', async ({
  page,
}) => {
  let requests = 0;
  await page.route(STREAM_URL, (route) =>
    route.fulfill({ status: 503, body: 'stream temporarily unavailable' }),
  );
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (requests === 2) {
      await route.fulfill({ status: 503, body: 'temporary status failure' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: requests >= 3 ? 'checked_in' : 'waiting',
        eta: null,
        activeConsultationRemainingMinutes: null,
      }),
    });
  });

  await openLiveQueue(page);
  const refresh = page.getByRole('button', { name: 'Actualiser mon statut' });
  await expect(refresh).toBeVisible();

  await refresh.click();
  await expect(
    page.getByRole('heading', { name: 'Statut potentiellement obsolète' }),
  ).toBeVisible();
  await expect(refresh).toBeVisible();

  await page.waitForTimeout(1_050);
  await refresh.click();
  await expect.poll(() => requests).toBe(3);
  await expect(page.getByText('enregistré')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Accès indisponible' }),
  ).toHaveCount(0);
});

test('manual refresh survives an optional stream failure and does not restart the stream immediately', async ({
  page,
}) => {
  let streamRequests = 0;
  let statusRequests = 0;
  await page.route(STREAM_URL, (route) => {
    streamRequests += 1;
    return route.fulfill({ status: 503, body: 'optional stream unavailable' });
  });
  await page.route(STATUS_URL, async (route) => {
    statusRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
        eta: null,
        activeConsultationRemainingMinutes: null,
      }),
    });
  });

  await openLiveQueue(page);
  await expect.poll(() => streamRequests).toBeGreaterThanOrEqual(1);
  const streamCountBeforeRefresh = streamRequests;
  const refresh = page.getByRole('button', { name: 'Actualiser mon statut' });
  await refresh.click();
  await expect.poll(() => statusRequests).toBe(2);
  expect(streamRequests).toBe(streamCountBeforeRefresh);
  await expect(
    page.getByRole('heading', { name: 'Accès indisponible' }),
  ).toHaveCount(0);
  await expect(refresh).toBeVisible();
});

test('last verified time advances only after an authoritative successful refresh', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-09-20T12:00:00.000Z'));
  let requests = 0;
  await page.route(STREAM_URL, (route) =>
    route.fulfill({ status: 503, body: 'optional stream unavailable' }),
  );
  await page.route(STATUS_URL, async (route) => {
    requests += 1;
    if (requests === 2) {
      await route.fulfill({ status: 503, body: 'temporary status failure' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: requests >= 3 ? 'checked_in' : 'waiting',
      }),
    });
  });

  await openLiveQueue(page);
  const verified = page.locator('time[datetime]');
  await expect(page.getByText('Dernière vérification :')).toBeVisible();
  await expect(verified).toHaveAttribute(
    'datetime',
    '2026-09-20T12:00:00.000Z',
  );

  await page.clock.setFixedTime(new Date('2026-09-20T12:02:00.000Z'));
  await page.getByRole('button', { name: 'Actualiser mon statut' }).click();
  await expect(
    page.getByRole('heading', { name: 'Statut potentiellement obsolète' }),
  ).toBeVisible();
  await expect(verified).toHaveAttribute(
    'datetime',
    '2026-09-20T12:00:00.000Z',
  );

  await page.clock.setFixedTime(new Date('2026-09-20T12:03:00.000Z'));
  await page.getByRole('button', { name: 'Actualiser mon statut' }).click();
  await expect.poll(() => requests).toBe(3);
  await expect(verified).toHaveAttribute(
    'datetime',
    '2026-09-20T12:03:00.000Z',
  );
  await expect(
    page.getByRole('heading', { name: 'Statut potentiellement obsolète' }),
  ).toHaveCount(0);
  expect(page.url()).not.toContain(BEARER);
});

test('Arabic RTL guest view localizes the last authoritative verification', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-09-20T12:00:00.000Z'));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'ar-DZ',
    });
  });
  await page.route(STATUS_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    }),
  );
  await openLiveQueue(page);
  await expect(page.getByText('آخر تحقق من الحالة:')).toBeVisible();
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.locator('time[datetime]')).toHaveAttribute(
    'datetime',
    '2026-09-20T12:00:00.000Z',
  );
});
