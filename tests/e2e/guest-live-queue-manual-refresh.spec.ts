import { expect, test, type Page } from '@playwright/test';

const BOOKING_URL = '**/api/public/bookings';
const STATUS_URL = '**/api/public/bookings/live-queue-status';
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
  await page.route(STATUS_URL, async (route) => {
    authorizations.push(route.request().headers()['authorization'] ?? '');
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
  expect(requests).toBe(2);
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
