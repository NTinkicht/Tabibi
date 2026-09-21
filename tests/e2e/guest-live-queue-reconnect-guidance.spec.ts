import { expect, test, type Page } from '@playwright/test';

const BOOKING_URL = '**/api/public/bookings';
const STATUS_URL = '**/api/public/bookings/live-queue-status';
const STREAM_URL = '/api/public/bookings/live-queue-stream';
const BEARER = 'reconnect-private-bearer.signature';

async function openLiveQueue(page: Page) {
  await page.route(BOOKING_URL, (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ queueLabel: 'G-123', guestBearer: BEARER }),
    }),
  );
  await page.route(STATUS_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
        eta: null,
        activeConsultationRemainingMinutes: null,
      }),
    }),
  );
  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel(/Votre nom|اسمك/).fill('Guest');
  await page.getByRole('button', { name: /Confirmer|تأكيد/ }).click();
  await expect(
    page.getByText(/Dernière vérification :|آخر تحقق من الحالة:/),
  ).toBeVisible();
}

test('French connection loss gives bounded fallback announcement, reconnect progress and recovery', async ({
  page,
}) => {
  await page.addInitScript((streamPath) => {
    const originalFetch = window.fetch.bind(window);
    let streamAttempts = 0;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input !== 'string' || input !== streamPath) {
        return originalFetch(input, init);
      }
      streamAttempts += 1;
      if (streamAttempts === 1) {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return new Promise<Response>((resolve) => {
        const testWindow = window as Window & {
          __releaseGuestStream?: () => void;
        };
        testWindow.__releaseGuestStream = () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(': ready\\n\\n'));
              // Keep the stream open until the test finishes.
            },
          });
          resolve(
            new Response(stream, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
          );
        };
      });
    };
  }, STREAM_URL);
  await openLiveQueue(page);

  const guidance = page.getByTestId('guest-stream-connection');
  const announcement = page.getByTestId('guest-stream-announcement');
  await expect(guidance).toContainText(
    'Notifications en direct interrompues. La vérification automatique continue',
  );
  await expect(announcement).toHaveCount(1);
  await expect(announcement).toContainText(
    'Notifications en direct interrompues.',
  );
  await expect(
    page.getByRole('button', { name: 'Actualiser mon statut' }),
  ).toBeEnabled();

  await expect(guidance).toContainText(
    'Reconnexion aux notifications en direct en cours.',
  );
  await expect(announcement).toHaveCount(1);
  await page.evaluate(() => {
    const testWindow = window as Window & {
      __releaseGuestStream?: () => void;
    };
    testWindow.__releaseGuestStream?.();
  });
  await expect(guidance).toContainText('Notifications en direct rétablies.');
  await expect(announcement).toHaveCount(1);
  await expect(announcement).toContainText(
    'Notifications en direct rétablies.',
  );
  await page.getByRole('button', { name: 'Actualiser mon statut' }).click();
  await expect(page.getByTestId('manual-refresh-feedback')).toContainText(
    'Nouvelle vérification réussie.',
  );
  expect(page.url()).not.toContain(BEARER);
  expect(await page.locator('body').innerText()).not.toContain(BEARER);
});

test('Arabic RTL fallback preserves canonical refresh and never exposes the bearer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'ar-DZ',
    });
  });
  let streamAttempts = 0;
  await page.route(`**${STREAM_URL}`, (route) => {
    streamAttempts += 1;
    return route.fulfill({ status: 503, body: 'stream unavailable' });
  });
  await openLiveQueue(page);

  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
  const guidance = page.getByTestId('guest-stream-connection');
  await expect(guidance).toContainText('انقطعت الإشعارات المباشرة.');
  await expect(guidance).toContainText('يستمر التحقق التلقائي');
  await expect(page.getByTestId('guest-stream-announcement')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'تحديث حالتي' })).toBeEnabled();
  await page.getByRole('button', { name: 'تحديث حالتي' }).click();
  await expect(page.getByTestId('manual-refresh-feedback')).toContainText(
    'نجح التحقق الجديد.',
  );
  expect(streamAttempts).toBeGreaterThanOrEqual(1);
  expect(page.url()).not.toContain(BEARER);
  expect(await page.locator('body').innerText()).not.toContain(BEARER);
});
