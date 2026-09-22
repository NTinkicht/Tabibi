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
  await page.route(STATUS_URL, (route) => {
    const request = route.request();
    expect(request.headers()['authorization']).toBe(`Bearer ${BEARER}`);
    expect(request.url()).not.toContain(BEARER);
    return route.fulfill({
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
  await page.addInitScript(
    ({ streamPath, bearer }) => {
      const originalFetch = window.fetch.bind(window);
      let streamAttempts = 0;
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (requestUrl.includes(bearer)) {
          return Promise.reject(
            new Error('guest bearer leaked into stream URL'),
          );
        }
        const parsedUrl = new URL(requestUrl, window.location.origin);
        if (parsedUrl.pathname !== streamPath) {
          return originalFetch(input, init);
        }
        const headers = new Headers(init?.headers);
        if (headers.get('authorization') !== `Bearer ${bearer}`) {
          return Promise.reject(
            new Error('stream request missing bearer authorization'),
          );
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
                controller.enqueue(new TextEncoder().encode(': ready\n\n'));
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
    },
    { streamPath: STREAM_URL, bearer: BEARER },
  );
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
    const request = route.request();
    expect(request.headers()['authorization']).toBe(`Bearer ${BEARER}`);
    expect(request.url()).not.toContain(BEARER);
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

for (const language of ['fr-FR', 'ar-DZ'] as const) {
  test(`Exhausted polling ${language} asks for manual retry`, async ({
    page,
  }) => {
    await page.clock.install();
    await page.addInitScript((locale) => {
      Object.defineProperty(navigator, 'language', {
        configurable: true,
        value: locale,
      });
    }, language);
    await page.route(`**${STREAM_URL}`, (route) => {
      const request = route.request();
      expect(request.headers()['authorization']).toBe(`Bearer ${BEARER}`);
      expect(request.url()).not.toContain(BEARER);
      return route.fulfill({ status: 503, body: 'stream unavailable' });
    });
    await openLiveQueue(page);
    await expect(page.getByTestId('guest-stream-connection')).toContainText(
      /vérification automatique continue|يستمر التحقق التلقائي/,
    );

    // Advance one polling boundary at a time. A single large virtual-clock
    // jump can outrun asynchronous fetch/React settling between retries.
    let failedStatusRequests = 0;
    await page.route(STATUS_URL, (route) => {
      const request = route.request();
      expect(request.headers()['authorization']).toBe(`Bearer ${BEARER}`);
      expect(request.url()).not.toContain(BEARER);
      failedStatusRequests += 1;
      return route.fulfill({ status: 503, body: 'status unavailable' });
    });
    const retryDelays = [31_000, 6_000, 16_000, 31_000, 61_000];
    for (const [index, delay] of retryDelays.entries()) {
      await page.clock.runFor(delay);
      await expect.poll(() => failedStatusRequests).toBe(index + 1);
      await expect(
        page.getByRole('heading', {
          name:
            index === retryDelays.length - 1
              ? /Connexion interrompue|انقطع الاتصال/
              : /Statut potentiellement obsolète|قد تكون الحالة قديمة/,
        }),
      ).toBeVisible();
    }

    await expect(page.getByTestId('guest-stream-connection')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(
      /vérification automatique continue|يستمر التحقق التلقائي/,
    );
    await expect(
      page.getByRole('button', {
        name: /Réessayer maintenant|إعادة المحاولة الآن/,
      }),
    ).toBeVisible();
    expect(page.url()).not.toContain(BEARER);
    expect(await page.locator('body').innerText()).not.toContain(BEARER);
  });
}
