import { expect, test } from '@playwright/test';

const activeStatus = {
  generatedAt: '2026-09-13T09:00:00Z',
  terminal: false,
  publicDisplayLabel: 'G-037',
  queueState: 'checked_in',
  clinicTimezone: 'Africa/Algiers',
  patientsAhead: 1,
  positionKind: 'live',
  arrivalWindow: null,
  session: { status: 'open', declaredDelayMinutes: null },
};

const notification = {
  id: '00000000-0000-4000-8000-000000000037',
  locale: 'en',
  direction: 'ltr',
  title: 'Your turn is approaching',
  body: 'Please stay nearby.',
  createdAt: '2026-09-13T09:01:00.000Z',
  readAt: null,
};

const secondNotification = {
  ...notification,
  id: '00000000-0000-4000-8000-000000000038',
  title: 'Doctor is nearly ready',
  createdAt: '2026-09-13T09:02:00.000Z',
};

async function routeStatus(page: import('@playwright/test').Page) {
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeStatus),
    });
  });
}

test('guest notification center renders unread items and marks one exact item read without browser persistence', async ({
  page,
}) => {
  await routeStatus(page);
  let inboxUrl = '';
  let readRequestUrl = '';

  await page.route('**/api/guest/inbox?limit=50', async (route) => {
    inboxUrl = route.request().url();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ unreadCount: 1, items: [notification] }),
    });
  });
  await page.route('**/api/guest/inbox/*/read', async (route) => {
    readRequestUrl = route.request().url();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...notification,
        readAt: '2026-09-13T09:02:00.000Z',
      }),
    });
  });

  await page.goto('/guest/status');
  await expect(
    page.getByRole('heading', { name: 'Notifications' }),
  ).toBeVisible();
  await expect(page.getByText('Unread: 1')).toBeVisible();
  await expect(page.getByText(notification.title)).toBeVisible();
  await expect(page.getByText(notification.body)).toBeVisible();

  expect(inboxUrl).toContain('/api/guest/inbox?limit=50');
  expect(inboxUrl).not.toMatch(/clinic|patient|account|subject/i);

  await page.getByRole('button', { name: 'Mark as read' }).click();
  await expect(page.getByText('Unread: 0')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as read' })).toHaveCount(
    0,
  );
  expect(readRequestUrl).toContain(`/api/guest/inbox/${notification.id}/read`);
  expect(readRequestUrl).not.toMatch(/clinic|patient|account|subject/i);

  expect(
    await page.evaluate(() => [
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ]),
  ).toEqual([]);
  expect(
    await page.evaluate(async () => (await indexedDB.databases()).length),
  ).toBe(0);
});

test('guest notification center refreshes a mounted visible page and only counts reachable unread items', async ({
  page,
}) => {
  await routeStatus(page);
  let requests = 0;
  await page.route('**/api/guest/inbox?limit=50', async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        requests === 1
          ? { unreadCount: 99, items: [notification] }
          : {
              unreadCount: 99,
              items: [
                { ...notification, readAt: '2026-09-13T09:03:00.000Z' },
                secondNotification,
              ],
            },
      ),
    });
  });

  await page.goto('/guest/status');
  await expect(page.getByText('Unread: 1')).toBeVisible();
  await expect(page.getByText(secondNotification.title)).toHaveCount(0);

  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  await expect(page.getByText(secondNotification.title)).toBeVisible();
  await expect(page.getByText('Unread: 1')).toBeVisible();
  expect(requests).toBeGreaterThanOrEqual(2);
});

test('guest notification center exposes a retryable mark-read failure without leaking scope', async ({
  page,
}) => {
  await routeStatus(page);
  await page.route('**/api/guest/inbox?limit=50', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ unreadCount: 1, items: [notification] }),
    });
  });
  let attempts = 0;
  let readRequestUrl = '';
  await page.route('**/api/guest/inbox/*/read', async (route) => {
    attempts += 1;
    readRequestUrl = route.request().url();
    if (attempts === 1) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...notification,
        readAt: '2026-09-13T09:04:00.000Z',
      }),
    });
  });

  await page.goto('/guest/status');
  const markRead = page.getByRole('button', { name: 'Mark as read' });
  await markRead.click();
  await expect(
    page.getByText('Could not mark this notification as read. Please try again.'),
  ).toBeVisible();
  await expect(markRead).toBeEnabled();
  expect(readRequestUrl).not.toMatch(/clinic|patient|account|subject/i);

  await markRead.click();
  await expect(page.getByText('Unread: 0')).toBeVisible();
  await expect(
    page.getByText('Could not mark this notification as read. Please try again.'),
  ).toHaveCount(0);
  expect(attempts).toBe(2);
});

test('guest notification center fails closed for revoked guest access', async ({
  page,
}) => {
  await routeStatus(page);
  await page.route('**/api/guest/inbox?limit=50', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{}',
    });
  });

  await page.goto('/guest/status');
  await expect(
    page.getByText('Notifications are unavailable for this guest session.'),
  ).toBeVisible();
  await expect(page.getByText(notification.title)).toHaveCount(0);
});

test('guest notification center exposes bounded retry for throttling', async ({
  page,
}) => {
  await routeStatus(page);
  let requests = 0;
  await page.route('**/api/guest/inbox?limit=50', async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: '{}',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ unreadCount: 0, items: [] }),
    });
  });

  await page.goto('/guest/status');
  await expect(
    page.getByText('Too many requests. Please try again shortly.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('No notifications yet.')).toBeVisible();
  expect(requests).toBe(2);
});
