import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

const clinicId = '30000000-0000-4000-8000-000000000001';
const DEAD_LETTERS_URL = `**/api/clinics/${clinicId}/notifications/dead-letters**`;
const rawQueueEntryId = '30000000-0000-4000-8000-000000000099';

async function authenticate(page: Page) {
  const secret =
    process.env.STAFF_SESSION_SECRET ??
    'browser-test-session-secret-at-least-32-characters';
  process.env.STAFF_SESSION_SECRET = secret;
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: createStaffSessionToken(
        'browser-notifications-reception',
        new Date(Date.now() + 60_000),
      ),
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}

function deadLettersBody(
  records: Array<{
    eventKey: string;
    queueLabel: string | null;
    attemptCount: number;
    maxAttempts: number;
    outcomeAt: string;
    outcomeCode?: string | null;
  }>,
) {
  return {
    deadLetters: records.map((record) => ({
      intentId: rawQueueEntryId,
      eventKey: record.eventKey,
      queueLabel: record.queueLabel,
      outcomeCode: record.outcomeCode ?? 'provider_unknown',
      attemptCount: record.attemptCount,
      maxAttempts: record.maxAttempts,
      outcomeAt: record.outcomeAt,
    })),
  };
}

test('French view renders a labelled exception, hides raw identifiers, and refresh re-fetches', async ({
  page,
}) => {
  await authenticate(page);
  let requestCount = 0;
  await page.route(DEAD_LETTERS_URL, async (route) => {
    requestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        deadLettersBody([
          {
            eventKey: 'patient_called',
            queueLabel: 'A-041',
            attemptCount: 3,
            maxAttempts: 5,
            outcomeAt: '2026-09-13T11:00:00.000Z',
          },
        ]),
      ),
    });
  });

  await page.goto(`/operations/${clinicId}/notifications?locale=fr`);
  await expect(
    page.getByRole('heading', { name: 'Notifications non remises' }),
  ).toBeVisible();
  await expect(page.getByText('Patient appelé')).toBeVisible();
  await expect(page.getByText('Passage: A-041')).toBeVisible();
  await expect(page.getByText('Tentatives de livraison: 3 / 5')).toBeVisible();
  // The raw provider outcome code ('provider_unknown') must never reach the
  // DOM -- only its generic, allow-listed category label may appear.
  await expect(page.getByText('Motif: Motif non précisé')).toBeVisible();

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain(rawQueueEntryId);
  expect(bodyText).not.toContain('provider_unknown');

  expect(requestCount).toBe(1);
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect.poll(() => requestCount).toBe(2);
});

test('Arabic view renders RTL with a localized event label and unmapped events fall back safely', async ({
  page,
}) => {
  await authenticate(page);
  await page.route(DEAD_LETTERS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        deadLettersBody([
          {
            eventKey: 'some_future_event',
            queueLabel: null,
            attemptCount: 1,
            maxAttempts: 1,
            outcomeAt: '2026-09-13T11:00:00.000Z',
            outcomeCode: 'retry_exhausted',
          },
        ]),
      ),
    });
  });

  await page.goto(`/operations/${clinicId}/notifications?locale=ar`);
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.getByText('إشعارات تعذّر تسليمها')).toBeVisible();
  // Unrecognized event keys fall back to the generic label, never the raw key.
  await expect(page.getByText('إشعار قائمة الانتظار')).toBeVisible();
  await expect(page.getByText('some_future_event')).toHaveCount(0);
  await expect(page.getByText('دور غير محدد')).toBeVisible();
  // A known outcome code maps to its generic category label; the raw
  // provider code string must never appear in the DOM.
  await expect(
    page.getByText('بلغ الحد الأقصى لمحاولات الإرسال'),
  ).toBeVisible();
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('retry_exhausted');
});

test('known internal dispatch failures have coarse French and Arabic labels without raw codes', async ({
  page,
}) => {
  await authenticate(page);
  const codes = [
    'delivery_context_failure',
    'in_app_delivery_context_mismatch',
    'render_failure',
    'in_app_persist_rejected',
    'in_app_persist_exception',
  ];
  await page.route(DEAD_LETTERS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        deadLettersBody(
          codes.map((outcomeCode) => ({
            eventKey: 'patient_called',
            queueLabel: 'A-041',
            attemptCount: 3,
            maxAttempts: 5,
            outcomeAt: '2026-09-13T11:00:00.000Z',
            outcomeCode,
          })),
        ),
      ),
    });
  });

  await page.goto(`/operations/${clinicId}/notifications?locale=fr`);
  await expect(
    page.getByText('Contexte de livraison indisponible'),
  ).toHaveCount(2);
  await expect(
    page.getByText('Préparation de la notification impossible'),
  ).toBeVisible();
  await expect(
    page.getByText('Enregistrement de la notification impossible'),
  ).toHaveCount(2);
  for (const code of codes)
    expect(await page.locator('body').innerText()).not.toContain(code);

  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page.getByText('تعذّر تحديد سياق التسليم')).toHaveCount(2);
  await expect(page.getByText('تعذّر إعداد الإشعار')).toBeVisible();
  await expect(page.getByText('تعذّر حفظ الإشعار')).toHaveCount(2);
  for (const code of codes)
    expect(await page.locator('body').innerText()).not.toContain(code);
});

test('mobile exceptions page uses reception-desk layout rather than the landing-page margin', async ({
  page,
}) => {
  await authenticate(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route(DEAD_LETTERS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(deadLettersBody([])),
    });
  });
  await page.goto(`/operations/${clinicId}/notifications?locale=ar`);
  const main = page.locator('main.notificationExceptions.desk');
  await expect(main).toBeVisible();
  await expect(page.locator('main[dir="rtl"]')).toBeVisible();
  expect(
    await main.evaluate((element) => getComputedStyle(element).marginTop),
  ).toBe('0px');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
});

test('shows the empty state when there are no delivery exceptions', async ({
  page,
}) => {
  await authenticate(page);
  await page.route(DEAD_LETTERS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(deadLettersBody([])),
    });
  });

  await page.goto(`/operations/${clinicId}/notifications?locale=fr`);
  await expect(
    page.getByText('Aucune notification en échec de livraison.'),
  ).toBeVisible();
});

test('shows an error state and recovers on refresh after a failed fetch', async ({
  page,
}) => {
  await authenticate(page);
  let attempt = 0;
  await page.route(DEAD_LETTERS_URL, async (route) => {
    attempt += 1;
    if (attempt === 1) {
      await route.fulfill({ status: 500, body: 'error' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(deadLettersBody([])),
    });
  });

  await page.goto(`/operations/${clinicId}/notifications?locale=fr`);
  await expect(
    page.getByText(
      'Impossible de charger les notifications. Veuillez réessayer.',
    ),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect(
    page.getByText('Aucune notification en échec de livraison.'),
  ).toBeVisible();
});

test('refresh is disabled while a request is in flight, so overlapping requests are never user-reachable', async ({
  page,
}) => {
  await authenticate(page);
  let requestCount = 0;
  const releaseHolder: { current: (() => void) | null } = { current: null };
  const released = new Promise<void>((resolve) => {
    releaseHolder.current = resolve;
  });

  await page.route(DEAD_LETTERS_URL, async (route) => {
    requestCount += 1;
    if (requestCount === 2) await released;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(deadLettersBody([])),
    });
  });

  await page.goto(`/operations/${clinicId}/notifications?locale=fr`);
  await expect(
    page.getByText('Aucune notification en échec de livraison.'),
  ).toBeVisible();

  const refresh = page.getByRole('button', { name: 'Actualiser' });
  await refresh.click();
  // While the refresh request is held open, the button must stay disabled --
  // this is what makes a second, overlapping dead-letters request
  // unreachable through the UI in the first place.
  await expect(refresh).toBeDisabled();
  await expect.poll(() => requestCount).toBe(2);
  await expect(refresh).toBeDisabled();

  releaseHolder.current?.();
  await expect(refresh).toBeEnabled();
});

test('reception desk links to the notification delivery exceptions page', async ({
  page,
}) => {
  await authenticate(page);
  await page.route(`**/api/clinics/${clinicId}/sessions**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions: [], timezone: 'UTC' }),
    });
  });

  await page.goto(`/operations/${clinicId}?locale=fr`);
  const link = page.getByRole('link', { name: 'Notifications non remises' });
  await expect(link).toHaveAttribute(
    'href',
    `/operations/${clinicId}/notifications?locale=fr`,
  );
});
