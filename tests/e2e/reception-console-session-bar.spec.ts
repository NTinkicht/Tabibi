import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
// All staff API calls are mocked with page.route; no server session is needed.
const clinicId = '20000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000002';
const entryId = '20000000-0000-4000-8000-000000000003';

function snapshot(
  status: 'open' | 'paused',
  delay: number | null,
  version: number,
) {
  return {
    entries: [
      {
        id: entryId,
        sessionId,
        state: 'checked_in',
        registrationOrder: 1,
        publicDisplayLabel: 'A-013',
        privateDisplayName: 'Yacine Haddad',
        preferredLocale: 'fr',
        hasContact: false,
        eligibilityOrder: 1,
        priorityOrder: null,
        origin: 'walk_in',
        appointmentStartsAt: null,
        activeConsultationRemainingMinutes: null,
        eta: null,
      },
    ],
    session: {
      doctorDisplayName: 'Dr Leila',
      startsAt: '2026-09-08T09:00:00.000Z',
      endsAt: '2026-09-08T12:00:00.000Z',
      status,
      declaredDelayMinutes: delay,
      delayVersion: version,
      queueOrderVersion: 1,
    },
    generatedAt: new Date().toISOString(),
    refreshAfterSeconds: 30,
  };
}

async function authenticate(page: Page) {
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: 'mocked-staff-session',
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}

test('session bar: delay step, pause banner and call next each issue one command', async ({
  page,
}) => {
  await authenticate(page);
  let status: 'open' | 'paused' = 'open';
  let delay: number | null = null;
  let version = 1;
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route('**/api/clinics/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(
      `/api/clinics/${clinicId}/sessions/${sessionId}/`,
      '',
    );
    if (request.method() === 'GET') {
      return route.fulfill({ json: snapshot(status, delay, version) });
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    posts.push({ path, body });
    if (path === 'delay') {
      delay = (body.minutes as number | undefined) ?? null;
      version += 1;
    } else if (path === 'commands') {
      status = body.command === 'pause' ? 'paused' : 'open';
    }
    return route.fulfill({
      json: path.endsWith('/commands')
        ? { entry: { id: entryId } }
        : { session: {} },
    });
  });

  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=fr`,
  );
  const callNext = page.getByRole('button', { name: /Appeler le suivant/ });
  await expect(callNext).toContainText('A-013 Yacine Haddad');
  await expect(callNext).toBeEnabled();

  await page.getByRole('button', { name: /Retard \+/ }).click();
  await expect(page.locator('.delayValue')).toContainText('5');
  expect(posts.at(-1)).toEqual({
    path: 'delay',
    body: { command: 'declare_delay', minutes: 5, expectedVersion: 1 },
  });

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    'les appels sont suspendus',
  );
  await expect(callNext).toBeDisabled();
  expect(posts.at(-1)).toEqual({
    path: 'commands',
    body: { command: 'pause' },
  });

  await page.getByRole('button', { name: 'Reprendre' }).click();
  await expect(callNext).toBeEnabled();
  await callNext.click();
  expect(posts.at(-1)?.path).toContain(`queue/${entryId}/commands`);
  expect(posts.at(-1)?.body.command).toBe('call');
});

test('session bar: rejected close keeps its error and controls stay busy until the refresh lands', async ({
  page,
}) => {
  await authenticate(page);
  let delayRefresh = false;
  await page.route('**/api/clinics/**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      if (delayRefresh) await new Promise((r) => setTimeout(r, 800));
      return route.fulfill({ json: snapshot('open', null, 1) });
    }
    const url = new URL(request.url()).pathname;
    if (url.endsWith('/commands')) {
      return route.fulfill({
        status: 409,
        json: { message: 'Session has active entries' },
      });
    }
    return route.fulfill({ json: { session: {} } });
  });
  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=fr`,
  );
  const plus = page.getByRole('button', { name: /Retard \+/ });
  await expect(plus).toBeEnabled();
  delayRefresh = true;
  await plus.click();
  await expect(plus).toBeDisabled();
  await expect(plus).toBeEnabled();
  delayRefresh = false;
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(page.locator('.alert')).toContainText(
    'Session has active entries',
  );
});
