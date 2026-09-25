import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

const clinicId = '30000000-0000-4000-8000-000000000001';
const sessionId = '30000000-0000-4000-8000-000000000002';

async function authenticate(page: Page) {
  process.env.STAFF_SESSION_SECRET =
    process.env.STAFF_SESSION_SECRET ??
    'browser-test-session-secret-at-least-32-characters';
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: createStaffSessionToken(
        'wu172-receptionist',
        new Date(Date.now() + 60_000),
      ),
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}

function dashboard(
  status: 'planned' | 'open' | 'paused' | 'closed' | 'cancelled' = 'open',
) {
  return {
    entries: [
      {
        id: '30000000-0000-4000-8000-000000000003',
        sessionId,
        state: 'waiting',
        registrationOrder: 1,
        publicDisplayLabel: 'W-PRIVATE',
        privateDisplayName: 'Example patient',
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

for (const locale of ['fr', 'ar'] as const) {
  test(`WU172 ${locale}: explicit confirmation, reason and privacy-minimal receipt`, async ({
    page,
  }) => {
    await authenticate(page);
    const requests: Array<{ reason: string; idempotencyKey: string | null }> =
      [];
    await page.route('**/dashboard', async (route) =>
      route.fulfill({ status: 200, json: dashboard() }),
    );
    await page.route('**/appointments/bulk-no-show', async (route) => {
      requests.push({
        reason: JSON.parse(route.request().postData() ?? '{}').reason,
        idempotencyKey: route.request().headers()['idempotency-key'] ?? null,
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
    const reasonLabel =
      locale === 'fr' ? 'Motif collectif obligatoire' : 'سبب جماعي إلزامي';
    const submit =
      locale === 'fr'
        ? 'Déclarer les absences éligibles'
        : 'تسجيل غياب المواعيد المؤهلة';
    await page
      .getByRole('textbox', { name: reasonLabel })
      .fill('Absence vérifiée');
    page.once('dialog', (dialog) => void dialog.dismiss());
    await page.getByRole('button', { name: submit }).click();
    expect(requests).toHaveLength(0);
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: submit }).click();
    await expect(page.getByRole('status')).toContainText(
      locale === 'fr' ? '1 rendez-vous éligible(s)' : 'تم تسجيل غياب 1',
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].reason).toBe('Absence vérifiée');
    expect(requests[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByRole('status')).not.toContainText('Example patient');
  });
}

test('WU172: retry after connectivity loss reuses the same key and zero-result is safe', async ({
  page,
}) => {
  await authenticate(page);
  const keys: string[] = [];
  await page.route('**/dashboard', async (route) =>
    route.fulfill({ status: 200, json: dashboard() }),
  );
  await page.route('**/appointments/bulk-no-show', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (keys.length === 1) await route.abort('failed');
    else
      await route.fulfill({
        status: 200,
        json: {
          receipt: {
            sessionId,
            scannedAppointmentCount: 0,
            resolvedAppointmentCount: 0,
            arrivalGraceMinutes: 15,
          },
        },
      });
  });
  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=fr`,
  );
  const button = page.getByRole('button', {
    name: 'Déclarer les absences éligibles',
  });
  await page
    .getByRole('textbox', { name: 'Motif collectif obligatoire' })
    .fill('Absence vérifiée');
  page.on('dialog', (dialog) => void dialog.accept());
  await button.click();
  await expect(page.getByRole('status')).toContainText(
    'La demande ou sa confirmation a échoué',
  );
  await button.click();
  await expect(page.getByRole('status')).toContainText(
    'Aucun rendez-vous éligible',
  );
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test('WU172: no bulk mutation is offered for terminal sessions', async ({
  page,
}) => {
  await authenticate(page);
  await page.route('**/dashboard', async (route) =>
    route.fulfill({ status: 200, json: dashboard('closed') }),
  );
  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=fr`,
  );
  await expect(page.getByText('Example patient')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Déclarer les absences éligibles' }),
  ).toHaveCount(0);
});
