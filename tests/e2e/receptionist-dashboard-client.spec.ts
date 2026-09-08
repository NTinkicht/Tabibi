import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

const clinicId = '20000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000002';

function dashboardSnapshot({
  patientName,
  publicDisplayLabel,
  queueOrderVersion,
  generatedAt,
}: {
  patientName: string;
  publicDisplayLabel: string;
  queueOrderVersion: number;
  generatedAt: string;
}) {
  return {
    entries: [
      {
        id: '20000000-0000-4000-8000-000000000003',
        sessionId,
        state: 'checked_in',
        registrationOrder: 1,
        publicDisplayLabel,
        privateDisplayName: patientName,
        preferredLocale: 'ar',
        hasContact: false,
        eligibilityOrder: 1,
        priorityOrder: null,
      },
    ],
    session: {
      doctorDisplayName: 'د. ليلى',
      startsAt: '2026-09-08T09:00:00.000Z',
      endsAt: '2026-09-08T12:00:00.000Z',
      status: 'open',
      declaredDelayMinutes: 15,
      delayVersion: 1,
      queueOrderVersion,
    },
    generatedAt,
    refreshAfterSeconds: 30,
  };
}

async function authenticate(page: Page) {
  const secret =
    process.env.STAFF_SESSION_SECRET ??
    'browser-test-session-secret-at-least-32-characters';
  process.env.STAFF_SESSION_SECRET = secret;
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: createStaffSessionToken(
        'browser-dashboard-reception',
        new Date(Date.now() + 60_000),
      ),
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}

test('background dashboard poll failure preserves the last good snapshot and marks it stale', async ({
  page,
}) => {
  await authenticate(page);
  await page.addInitScript(() => {
    const originalSetInterval = globalThis.setInterval;
    const originalSetTimeout = globalThis.setTimeout;
    const acceleratedSetInterval = (
      ...params: Parameters<typeof globalThis.setInterval>
    ): ReturnType<typeof globalThis.setInterval> => {
      const [handler, timeout, ...args] = params;
      if (timeout === 30_000) {
        return originalSetTimeout(
          handler as never,
          50,
          ...(args as never[]),
        ) as ReturnType<typeof globalThis.setInterval>;
      }
      return originalSetInterval(
        handler as never,
        timeout === 5_000 ? 50 : timeout,
        ...(args as never[]),
      );
    };
    window.setInterval = acceleratedSetInterval as typeof window.setInterval;
  });

  let dashboardRequests = 0;
  await page.route(
    `**/api/clinics/${clinicId}/sessions/${sessionId}/dashboard`,
    async (route) => {
      dashboardRequests += 1;
      if (dashboardRequests === 1) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            dashboardSnapshot({
              patientName: 'مريض ثابت',
              publicDisplayLabel: 'W-KEEP00001',
              queueOrderVersion: 1,
              generatedAt: new Date().toISOString(),
            }),
          ),
        });
        return;
      }

      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Transient dashboard fetch failed' }),
      });
    },
  );

  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=ar`,
  );
  await expect(
    page.getByRole('heading', { name: 'قائمة المرضى بدون موعد' }),
  ).toBeVisible();
  await expect(page.getByText('مريض ثابت', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'تقديم / إعادة ترتيب (مدقّق)' }),
  ).toBeVisible();

  await expect.poll(() => dashboardRequests).toBeGreaterThan(1);
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Transient dashboard fetch failed' }),
  ).toBeVisible();
  await expect(
    page
      .getByLabel('لوحة عمليات الاستقبال')
      .getByText('البيانات قديمة — قم بالتحديث'),
  ).toBeVisible();
  await page.waitForTimeout(200);
  await expect(
    page
      .getByLabel('لوحة عمليات الاستقبال')
      .getByText('البيانات قديمة — قم بالتحديث'),
  ).toBeVisible();
  await expect(page.getByText('مريض ثابت', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'تقديم / إعادة ترتيب (مدقّق)' }),
  ).toBeVisible();
});

test('a newer dashboard response is not overwritten by an older overlapping reload', async ({
  page,
}) => {
  await authenticate(page);

  let dashboardRequests = 0;
  await page.route(
    `**/api/clinics/${clinicId}/sessions/${sessionId}/dashboard`,
    async (route) => {
      dashboardRequests += 1;
      if (dashboardRequests === 1) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            dashboardSnapshot({
              patientName: 'مريض أساسي',
              publicDisplayLabel: 'W-BASE0001',
              queueOrderVersion: 1,
              generatedAt: '2026-09-08T09:00:00.000Z',
            }),
          ),
        });
        return;
      }

      if (dashboardRequests === 2) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            dashboardSnapshot({
              patientName: 'مريض قديم',
              publicDisplayLabel: 'W-OLD00001',
              queueOrderVersion: 2,
              generatedAt: '2026-09-08T09:00:30.000Z',
            }),
          ),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          dashboardSnapshot({
            patientName: 'مريض أحدث',
            publicDisplayLabel: 'W-NEW00001',
            queueOrderVersion: 3,
            generatedAt: '2026-09-08T09:01:00.000Z',
          }),
        ),
      });
    },
  );

  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=ar`,
  );
  await expect(page.getByText('مريض أساسي', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'تحديث' }).click();
  await page.getByRole('button', { name: 'تحديث' }).click();

  await expect(page.getByText('مريض أحدث', { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByText('مريض أحدث', { exact: true })).toBeVisible();
  await expect(page.getByText('W-NEW00001', { exact: true })).toBeVisible();
  await expect(page.getByText('مريض قديم', { exact: true })).toHaveCount(0);
  await expect(page.getByText('W-OLD00001', { exact: true })).toHaveCount(0);
});
