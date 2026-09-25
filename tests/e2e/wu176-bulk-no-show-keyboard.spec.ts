import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

const clinicId = '31000000-0000-4000-8000-000000000001';
const sessionId = '31000000-0000-4000-8000-000000000002';

async function authenticate(page: Page) {
  process.env.STAFF_SESSION_SECRET =
    process.env.STAFF_SESSION_SECRET ??
    'browser-test-session-secret-at-least-32-characters';
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: createStaffSessionToken(
        'wu176-receptionist',
        new Date(Date.now() + 60_000),
      ),
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}

function dashboard(status: 'open' | 'closed' = 'open') {
  return {
    entries: [
      {
        id: '31000000-0000-4000-8000-000000000003',
        sessionId,
        state: 'waiting',
        registrationOrder: 1,
        publicDisplayLabel: 'W-176',
        privateDisplayName: 'Synthetic hidden patient',
        preferredLocale: 'fr',
        hasContact: false,
        eligibilityOrder: null,
        priorityOrder: null,
      },
    ],
    session: {
      doctorDisplayName: 'Médecin',
      startsAt: '2026-09-25T09:00:00.000Z',
      endsAt: '2026-09-25T12:00:00.000Z',
      status,
      declaredDelayMinutes: null,
      delayVersion: 0,
      queueOrderVersion: 1,
    },
    generatedAt: new Date().toISOString(),
    refreshAfterSeconds: 30,
  };
}

/** Prove genuine sequential keyboard access; never programmatically focus. */
async function reachByTab(page: Page, target: Locator): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement))
      return;
  }
  throw new Error('WU176 keyboard traversal never reached the control');
}

for (const locale of ['fr', 'ar'] as const) {
  test(`WU176 ${locale}: receptionist bulk absence is keyboard operable and privacy-safe`, async ({
    page,
  }) => {
    await authenticate(page);
    const requests: Array<{ reason: string; key: string }> = [];
    await page.route('**/dashboard', async (route) =>
      route.fulfill({ status: 200, json: dashboard() }),
    );
    await page.route('**/appointments/bulk-no-show', async (route) => {
      requests.push({
        reason: JSON.parse(route.request().postData() ?? '{}').reason,
        key: route.request().headers()['idempotency-key'] ?? '',
      });
      await route.fulfill({
        status: 200,
        json: {
          receipt: {
            sessionId,
            scannedAppointmentCount: 2,
            resolvedAppointmentCount: 1,
            arrivalGraceMinutes: 15,
          },
        },
      });
    });

    await page.goto(
      `/operations/${clinicId}/sessions/${sessionId}/queue?locale=${locale}`,
    );
    const reason = page.getByRole('textbox', {
      name:
        locale === 'fr' ? 'Motif collectif obligatoire' : 'سبب جماعي إلزامي',
    });
    const submit = page.getByRole('button', {
      name:
        locale === 'fr'
          ? 'Déclarer les absences éligibles'
          : 'تسجيل غياب المواعيد المؤهلة',
    });
    await expect(reason).toBeVisible();
    await reachByTab(page, reason);
    await expect(reason).toBeFocused();
    await page.keyboard.type('Verified absence');
    await reachByTab(page, submit);
    await expect(submit).toBeFocused();

    page.once('dialog', (dialog) => void dialog.dismiss());
    await page.keyboard.press('Enter');
    expect(requests).toHaveLength(0);

    // Native confirmation cancellation cannot mutate. A subsequent keyboard
    // activation must be independently confirmed before one safe POST.
    await expect(submit).toBeFocused();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(
      locale === 'fr' ? '1 rendez-vous éligible(s)' : 'تم تسجيل غياب 1',
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ reason: 'Verified absence' });
    expect(requests[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByRole('status')).not.toContainText(
      'Synthetic hidden patient',
    );
  });
}

test('WU176: terminal session hides the keyboard bulk action', async ({
  page,
}) => {
  await authenticate(page);
  await page.route('**/dashboard', async (route) =>
    route.fulfill({ status: 200, json: dashboard('closed') }),
  );
  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=fr`,
  );
  await expect(page.getByText('Synthetic hidden patient')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Déclarer les absences éligibles' }),
  ).toHaveCount(0);
});
