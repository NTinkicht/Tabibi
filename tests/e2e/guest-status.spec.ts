import { expect, test } from '@playwright/test';

const activeWaiting = {
  generatedAt: '2026-09-10T09:00:00Z',
  terminal: false,
  publicDisplayLabel: 'G-018',
  queueState: 'waiting',
  clinicTimezone: 'Africa/Algiers',
  patientsAhead: null,
  positionKind: 'provisional',
  arrivalWindow: {
    earliestAt: '2026-09-10T09:30:00Z',
    latestAt: '2026-09-10T09:45:00Z',
    uncertaintyMinutes: 15,
  },
  session: { status: 'open', declaredDelayMinutes: 10 },
};

const activeEligible = {
  ...activeWaiting,
  queueState: 'checked_in',
  patientsAhead: 2,
  positionKind: 'live' as const,
  arrivalWindow: null,
};

test('guest status renders provisional waiting state without leaking bearer material', async ({
  page,
}) => {
  const rawBearer = '00000000-0000-4000-8000-000000000018.test-guest-bearer';
  await page.context().addCookies([
    {
      name: '__Host-tabibi_guest',
      value: rawBearer,
      url: 'https://localhost:3000',
      secure: true,
      httpOnly: true,
    },
  ]);
  let statusRequestCookie = '';
  await page.route('**/api/guest/status', async (route) => {
    statusRequestCookie = route.request().headers()['cookie'] ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeWaiting),
    });
  });

  const response = await page.goto('http://localhost:3000/guest/status');
  await expect(page.getByText('G-018')).toBeVisible();
  await expect(page.getByText(/Expected arrival window:/)).toBeVisible();
  await expect(page.getByText(/Declared clinic delay:/)).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'What to do while waiting' }),
  ).toHaveAttribute('href', '/guest/queue-next-steps');
  const explainer = page.getByRole('link', {
    name: 'Why estimates can change',
  });
  await expect(explainer).toHaveAttribute(
    'href',
    '/guest/eta-explained?lang=fr',
  );
  await expect(explainer).toHaveAttribute('target', '_blank');
  await expect(explainer).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(explainer).toHaveAttribute(
    'aria-describedby',
    'tabibi-guest-status-eta-explainer-hint',
  );
  await expect(
    page.locator('#tabibi-guest-status-eta-explainer-hint'),
  ).toHaveText('(opens in a new tab)');
  expect(statusRequestCookie).toContain(`__Host-tabibi_guest=${rawBearer}`);
  expect(await page.locator('body').innerText()).not.toContain(rawBearer);
  expect(page.url()).not.toContain(rawBearer);
  expect(
    await page.evaluate(() => [
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ]),
  ).not.toContain(rawBearer);
  expect(response?.headers()['cache-control']).toContain('no-store');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  expect(response?.headers()['content-security-policy']).toContain(
    "default-src 'self'",
  );
});

test('guest status renders exact patients-ahead only for a live eligible snapshot', async ({
  page,
}) => {
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeEligible),
    });
  });

  await page.goto('/guest/status');
  await expect(page.getByText('Patients ahead: 2')).toBeVisible();
  await expect(page.getByText(/Expected arrival window:/)).toHaveCount(0);
});

test('guest status stops on terminal response', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/guest/status', async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: '2026-09-10T09:05:00Z',
        terminal: true,
        finalStatus: 'completed',
      }),
    });
  });

  await page.goto('/guest/status');
  await expect(
    page.getByRole('heading', { name: 'Visit status' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Why estimates can change' }),
  ).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(requests).toBe(1);
});

test('guest status stops on unauthorized response', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/guest/status', async (route) => {
    requests += 1;
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{}',
    });
  });

  await page.goto('/guest/status');
  await expect(
    page.getByRole('heading', { name: 'Guest access unavailable' }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  expect(requests).toBe(1);
});

test('guest status honors Retry-After before retrying a throttled request', async ({
  page,
}) => {
  let requests = 0;
  await page.route('**/api/guest/status', async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({
        status: 429,
        headers: { 'retry-after': '1' },
        body: '{}',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeEligible),
    });
  });

  await page.goto('/guest/status');
  await page.waitForTimeout(300);
  expect(requests).toBe(1);
  await expect(page.getByText('Patients ahead: 2')).toBeVisible({
    timeout: 2_000,
  });
  expect(requests).toBe(2);
});

test('guest status renders paused and planned session states explicitly', async ({
  page,
}) => {
  let status = 'paused';
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...activeEligible,
        session: { status, declaredDelayMinutes: null },
      }),
    });
  });

  await page.goto('/guest/status');
  await expect(page.getByText(/Clinic session:/)).toBeVisible();
  await expect(page.getByText(/temporarily paused/)).toBeVisible();

  status = 'planned';
  await page.reload();
  await expect(page.getByText(/not started yet/)).toBeVisible();
});

test('guest status selects French copy from browser locale', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'fr-DZ' });
  });
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeEligible),
    });
  });

  await page.goto('/guest/status');
  await expect(page.getByText('Patients avant vous : 2')).toBeVisible();
  await expect(page.locator('section[lang="fr"][dir="ltr"]')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Que faire pendant l’attente' }),
  ).toHaveAttribute('href', '/guest/queue-next-steps');
  const explainer = page.getByRole('link', {
    name: 'Pourquoi ces estimations changent',
  });
  await expect(explainer).toHaveAttribute(
    'href',
    '/guest/eta-explained?lang=fr',
  );
  await expect(explainer).toHaveAttribute('rel', 'noopener noreferrer');
});

test('guest status selects Arabic RTL copy from browser locale', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'ar-DZ' });
  });
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeEligible),
    });
  });

  await page.goto('/guest/status');
  await expect(page.getByText('المرضى قبلك: 2')).toBeVisible();
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'ماذا تفعل أثناء الانتظار' }),
  ).toHaveAttribute('href', '/guest/queue-next-steps');
  const explainer = page.getByRole('link', {
    name: 'لماذا تتغير هذه التقديرات',
  });
  await expect(explainer).toHaveAttribute(
    'href',
    '/guest/eta-explained?lang=ar',
  );
  await expect(explainer).toHaveAttribute('target', '_blank');
  await expect(explainer).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(
    page.locator('#tabibi-guest-status-eta-explainer-hint'),
  ).toHaveText('(يُفتح في علامة تبويب جديدة)');
});

test('guest status formats arrival times in the clinic timezone', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'fr-DZ' });
  });
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeWaiting),
    });
  });

  await page.goto('/guest/status');
  await expect(page.getByText(/10:30.*10:45/)).toBeVisible();
});

test('guest status closes SSE while hidden and performs a canonical poll when visible again', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let hidden = false;
    const streamState = {
      created: 0,
      closed: 0,
      urls: [] as string[],
    };

    class TestEventSource {
      onerror: ((this: EventSource, ev: Event) => unknown) | null = null;

      constructor(url: string | URL) {
        streamState.created += 1;
        streamState.urls.push(String(url));
      }

      addEventListener() {}

      close() {
        streamState.closed += 1;
      }
    }

    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      value: TestEventSource,
    });
    Object.defineProperty(window, '__guestStatusStreamStateForTest', {
      configurable: true,
      value: streamState,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    Object.defineProperty(window, '__setGuestStatusHiddenForTest', {
      configurable: true,
      value: (value: boolean) => {
        hidden = value;
        document.dispatchEvent(new Event('visibilitychange'));
      },
    });
  });

  let polls = 0;
  await page.route('**/api/guest/status', async (route) => {
    polls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeEligible),
    });
  });

  await page.goto('/guest/status');
  await expect(page.getByText('Patients ahead: 2')).toBeVisible();
  expect(polls).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __guestStatusStreamStateForTest: {
                created: number;
                closed: number;
                urls: string[];
              };
            }
          ).__guestStatusStreamStateForTest.created,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __guestStatusStreamStateForTest: { urls: string[] };
          }
        ).__guestStatusStreamStateForTest.urls[0],
    ),
  ).toBe('/api/guest/status/stream');

  await page.evaluate(() => {
    (
      window as typeof window & {
        __setGuestStatusHiddenForTest: (value: boolean) => void;
      }
    ).__setGuestStatusHiddenForTest(true);
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __guestStatusStreamStateForTest: { closed: number };
            }
          ).__guestStatusStreamStateForTest.closed,
      ),
    )
    .toBe(1);

  await page.evaluate(() => {
    (
      window as typeof window & {
        __setGuestStatusHiddenForTest: (value: boolean) => void;
      }
    ).__setGuestStatusHiddenForTest(false);
  });

  await expect.poll(() => polls).toBe(2);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __guestStatusStreamStateForTest: { created: number };
            }
          ).__guestStatusStreamStateForTest.created,
      ),
    )
    .toBe(2);
});

async function mockStatus(
  page: import('@playwright/test').Page,
  body: unknown,
  language?: string,
) {
  if (language) {
    await page.addInitScript((value) => {
      Object.defineProperty(navigator, 'language', { get: () => value });
    }, language);
  }
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

test('guest status is read-only: no check-in button and no wait range', async ({
  page,
}) => {
  await mockStatus(page, activeWaiting, 'fr-DZ');
  await page.goto('/guest/status');
  await expect(
    page.getByText('Signalez votre arrivée à l’accueil.'),
  ).toBeVisible();
  await expect(page.getByText(/Votre position est provisoire/)).toBeVisible();
  await expect(
    page.locator('section[lang="fr"]').getByRole('button'),
  ).toHaveCount(0);
  await expect(page.getByText(/Attente estimée|min–/)).toHaveCount(0);
});

test('guest status shows the called panel as a status region', async ({
  page,
}) => {
  await mockStatus(
    page,
    { ...activeEligible, queueState: 'called', patientsAhead: 0 },
    'fr-DZ',
  );
  await page.goto('/guest/status');
  const panel = page
    .getByRole('status')
    .filter({ hasText: 'C’est votre tour' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('G-018');
});

test('guest status shows a paused panel that keeps the place', async ({
  page,
}) => {
  await mockStatus(page, {
    ...activeEligible,
    session: { status: 'paused', declaredDelayMinutes: null },
  });
  await page.goto('/guest/status');
  await expect(page.getByText('Consultations are paused')).toBeVisible();
  await expect(page.getByText('Patients ahead: 2')).toBeVisible();
});

for (const [finalStatus, expected] of [
  ['completed', 'Your visit is finished.'],
  ['cancelled', 'Your appointment was cancelled.'],
  ['no_show', 'You were marked absent. Please contact reception.'],
] as const) {
  test(`guest status terminal outcome ${finalStatus} has its own copy`, async ({
    page,
  }) => {
    await mockStatus(page, {
      generatedAt: '2026-09-10T09:05:00Z',
      terminal: true,
      finalStatus,
    });
    await page.goto('/guest/status');
    await expect(page.getByText(expected)).toBeVisible();
    await expect(page.getByText('This page no longer updates.')).toBeVisible();
    for (const [other, text] of [
      ['completed', 'Your visit is finished.'],
      ['cancelled', 'Your appointment was cancelled.'],
    ] as const) {
      if (other !== finalStatus) {
        await expect(page.getByText(text)).toHaveCount(0);
      }
    }
  });
}

test('guest status Arabic RTL fits a 360px phone without horizontal scroll and renders no identifiers', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await mockStatus(page, activeEligible, 'ar-DZ');
  await page.goto('/guest/status');
  await expect(page.getByText('المرضى قبلك: 2')).toBeVisible();
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/\+?\d{9,}|@|Dr\b|Dr\./);
});

test('guest status called panel heading is white on the primary background', async ({
  page,
}) => {
  await mockStatus(page, { ...activeEligible, queueState: 'called' });
  await page.goto('/guest/status');
  const heading = page.getByRole('heading', { name: 'It is your turn' });
  await expect(heading).toBeVisible();
  expect(await heading.evaluate((el) => getComputedStyle(el).color)).toBe(
    'rgb(255, 255, 255)',
  );
});

test('guest status closed terminal outcome has its own copy', async ({
  page,
}) => {
  await mockStatus(page, {
    generatedAt: '2026-09-10T09:05:00Z',
    terminal: true,
    finalStatus: 'closed',
  });
  await page.goto('/guest/status');
  await expect(page.getByText('The clinic session is closed.')).toBeVisible();
  await expect(page.getByText('This page no longer updates.')).toBeVisible();
});

for (const [label, body, tone] of [
  ['called', { ...activeEligible, queueState: 'called' }, 'called'],
  [
    'in_consultation',
    { ...activeEligible, queueState: 'in_consultation' },
    'active',
  ],
  [
    'paused session',
    {
      ...activeEligible,
      session: { status: 'paused', declaredDelayMinutes: null },
    },
    'warning',
  ],
  ['live', activeEligible, 'arrived'],
  ['provisional', activeWaiting, 'neutral'],
] as const) {
  test(`guest status chip tone for ${label} is ${tone}`, async ({ page }) => {
    await mockStatus(page, body);
    await page.goto('/guest/status');
    await expect(page.locator(`section.gs-page .tb-chip--${tone}`)).toHaveCount(
      1,
    );
    await expect(page.locator('section.gs-page .tb-chip')).toHaveCount(1);
  });
}

test('guest status shows the delay notice only when a delay is declared', async ({
  page,
}) => {
  await mockStatus(page, activeWaiting);
  await page.goto('/guest/status');
  await expect(page.locator('.gs-delay')).toContainText('10');
  await page.unroute('**/api/guest/status');
  await mockStatus(page, {
    ...activeWaiting,
    session: { status: 'open', declaredDelayMinutes: null },
  });
  await page.reload();
  await expect(page.getByText('Patients ahead:')).toHaveCount(0);
  await expect(page.locator('.gs-delay')).toHaveCount(0);
});

test('guest status footer has help links and the privacy line', async ({
  page,
}) => {
  await mockStatus(page, activeEligible);
  await page.goto('/guest/status');
  const footer = page.locator('footer.gs-footer');
  await expect(
    footer.getByRole('link', { name: 'What to do while waiting' }),
  ).toHaveAttribute('href', '/guest/queue-next-steps');
  await expect(footer.getByRole('link', { name: 'Help' })).toHaveAttribute(
    'href',
    '/guest/help',
  );
  await expect(footer).toContainText(
    'This page shows no name, phone number, doctor or clinic identifier.',
  );
});
