import { expect, test } from '@playwright/test';

const activeStatus = {
  generatedAt: '2026-09-13T09:00:00Z',
  terminal: false,
  publicDisplayLabel: 'G-200',
  queueState: 'checked_in',
  clinicTimezone: 'Africa/Algiers',
  patientsAhead: 1,
  positionKind: 'live',
  arrivalWindow: null,
  session: { status: 'open', declaredDelayMinutes: null },
};

const notification = {
  id: '00000000-0000-4000-8000-000000000200',
  locale: 'en',
  direction: 'ltr',
  title: 'Your turn is approaching',
  body: 'Please stay nearby.',
  createdAt: '2026-09-13T09:01:00.000Z',
  readAt: null,
};

const secondNotification = {
  ...notification,
  id: '00000000-0000-4000-8000-000000000201',
  title: 'Doctor is nearly ready',
  createdAt: '2026-09-13T09:02:00.000Z',
};

test('concurrent refresh cannot clobber an in-flight mark-read or lose a newly arrived notification', async ({
  page,
}) => {
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeStatus),
    });
  });

  let inboxRequests = 0;
  await page.route('**/api/guest/inbox?limit=50', async (route) => {
    inboxRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        inboxRequests === 1
          ? { unreadCount: 1, items: [notification] }
          : { unreadCount: 2, items: [notification, secondNotification] },
      ),
    });
  });

  let releaseRead!: () => void;
  const heldRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await page.route('**/api/guest/inbox/*/read', async (route) => {
    await heldRead;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...notification,
        readAt: '2026-09-13T09:03:00.000Z',
      }),
    });
  });

  await page.goto('/guest/status');
  await expect(page.getByText(notification.title)).toBeVisible();
  await expect(page.getByText('Unread: 1')).toBeVisible();

  await page.getByRole('button', { name: 'Mark as read' }).click();
  const pending = page.getByRole('button', { name: 'Marking as read…' });
  await expect(pending).toBeDisabled();

  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(page.getByText(secondNotification.title)).toBeVisible();
  await expect(pending).toBeDisabled();
  await expect(page.getByText('Unread: 2')).toBeVisible();

  releaseRead();

  await expect(page.getByText(secondNotification.title)).toBeVisible();
  await expect(page.getByText('Unread: 1')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Marking as read…' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark as read' })).toHaveCount(
    1,
  );
  expect(inboxRequests).toBeGreaterThanOrEqual(2);
});

test('stale refresh that started before mark-read cannot restore an acknowledged item to unread', async ({
  page,
}) => {
  await page.route('**/api/guest/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activeStatus),
    });
  });

  let inboxRequests = 0;
  let releaseRefresh!: () => void;
  const heldRefresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let refreshStarted!: () => void;
  const refreshStartedPromise = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });

  await page.route('**/api/guest/inbox?limit=50', async (route) => {
    inboxRequests += 1;
    if (inboxRequests === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ unreadCount: 1, items: [notification] }),
      });
      return;
    }

    refreshStarted();
    await heldRefresh;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ unreadCount: 1, items: [notification] }),
    });
  });

  await page.route('**/api/guest/inbox/*/read', async (route) => {
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
  await expect(page.getByText('Unread: 1')).toBeVisible();

  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await refreshStartedPromise;

  await page.getByRole('button', { name: 'Mark as read' }).click();
  await expect(page.getByText('Unread: 0')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as read' })).toHaveCount(
    0,
  );

  releaseRefresh();

  await expect(page.getByText('Unread: 0')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as read' })).toHaveCount(
    0,
  );
  expect(inboxRequests).toBe(2);
});
