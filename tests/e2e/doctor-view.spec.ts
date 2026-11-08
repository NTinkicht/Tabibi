import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
// All staff API calls are mocked with page.route; no server session is needed.
const clinicId = '20000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000002';

type State =
  | 'checked_in'
  | 'called'
  | 'in_consultation'
  | 'completed'
  | 'no_show';
function row(id: string, order: number, state: State, name: string) {
  return {
    id,
    sessionId,
    state,
    registrationOrder: order,
    publicDisplayLabel: `A-0${order}`,
    privateDisplayName: name,
    preferredLocale: 'fr',
    hasContact: false,
    eligibilityOrder: order,
    priorityOrder: null,
    origin: 'walk_in',
    appointmentStartsAt: null,
    activeConsultationRemainingMinutes: state === 'in_consultation' ? 7 : null,
    eta: { minWaitMinutes: 10, maxWaitMinutes: 20 },
  };
}

async function setup(page: Page, reject = false) {
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: 'mocked-staff-session',
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  const states: Record<string, State> = {
    a: 'in_consultation',
    b: 'checked_in',
  };
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route('**/api/clinics/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(
      `/api/clinics/${clinicId}/sessions/${sessionId}/`,
      '',
    );
    if (request.method() === 'GET') {
      return route.fulfill({
        json: {
          entries: [
            row('a', 1, states.a, 'Yacine Haddad'),
            row('b', 2, states.b, 'Salima Benali'),
          ],
          session: {
            doctorDisplayName: 'Dr Leila',
            startsAt: '2026-09-08T09:00:00.000Z',
            endsAt: '2026-09-08T12:00:00.000Z',
            status: 'open',
            declaredDelayMinutes: null,
            delayVersion: 1,
            queueOrderVersion: 1,
          },
          generatedAt: new Date().toISOString(),
          refreshAfterSeconds: 30,
        },
      });
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    posts.push({ path, body });
    if (reject)
      return route.fulfill({ status: 409, json: { message: 'Stale entry' } });
    const id = path.split('/')[1];
    const next: Record<string, State> = {
      complete_consultation: 'completed',
      start_consultation: 'in_consultation',
      call: 'called',
      no_show: 'no_show',
    };
    states[id] = next[body.command as string];
    return route.fulfill({ json: { entry: { id } } });
  });
  return posts;
}

const url = `/operations/${clinicId}/sessions/${sessionId}/doctor?locale=fr`;

test('doctor view: complete, call next, start each issue exactly one command', async ({
  page,
}) => {
  const posts = await setup(page);
  await page.goto(url);
  const primary = page.locator('.doctorPrimary');
  await expect(primary).toHaveText('Terminer la consultation');
  await expect(page.getByText('≈ 7 min restantes')).toBeVisible();
  await primary.click();
  await expect(primary).toContainText(
    'Appeler le suivant · A-02 · Salima Benali',
  );
  expect(posts.map((p) => [p.path, p.body.command])).toEqual([
    ['queue/a/commands', 'complete_consultation'],
  ]);
  await primary.click();
  await expect(primary).toContainText('Démarrer la consultation · A-02');
  await expect(page.getByText('Appelé, en route vers vous')).toBeVisible();
  await primary.click();
  await expect(primary).toHaveText('Terminer la consultation');
  expect(posts.map((p) => p.body.command)).toEqual([
    'complete_consultation',
    'call',
    'start_consultation',
  ]);
});

test('doctor view: no-show needs a reason', async ({ page }) => {
  const posts = await setup(page);
  await page.goto(url);
  await page.locator('.doctorPrimary').click();
  await page.locator('.doctorPrimary').click();
  await page
    .getByRole('button', { name: 'Le patient ne se présente pas' })
    .click();
  const confirm = page.getByRole('button', { name: 'Confirmer l’absence' });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Motif opérationnel (obligatoire)').fill('Injoignable');
  await confirm.click();
  await expect(page.getByText('Aucun patient en consultation')).toBeVisible();
  expect(posts.at(-1)?.body).toEqual({
    command: 'no_show',
    reason: 'Injoignable',
  });
});

test('doctor view: a rejected command leaves the screen unchanged and shows the error', async ({
  page,
}) => {
  await setup(page, true);
  await page.goto(url);
  await page.locator('.doctorPrimary').click();
  await expect(page.locator('.doctorError')).toContainText('Stale entry');
  await expect(page.locator('.doctorPrimary')).toHaveText(
    'Terminer la consultation',
  );
});

test('doctor view renders RTL in Arabic', async ({ page }) => {
  await setup(page);
  await page.goto(url.replace('locale=fr', 'locale=ar'));
  await expect(page.locator('main.doctorView')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('.doctorPrimary')).toHaveText('إنهاء الاستشارة');
});

test('doctor view: resume after a lost pause response uses a different idempotency key', async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: 'mocked-staff-session',
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  let status: 'open' | 'paused' = 'open';
  let lostFirst = false;
  const keys: Array<{ command: unknown; key: string | undefined }> = [];
  await page.route('**/api/clinics/**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET')
      return route.fulfill({
        json: {
          entries: [row('a', 1, 'in_consultation', 'Yacine Haddad')],
          session: {
            doctorDisplayName: 'Dr Leila',
            startsAt: '2026-09-08T09:00:00.000Z',
            endsAt: '2026-09-08T12:00:00.000Z',
            status,
            declaredDelayMinutes: null,
            delayVersion: 1,
            queueOrderVersion: 1,
          },
          generatedAt: new Date().toISOString(),
          refreshAfterSeconds: 30,
        },
      });
    const body = request.postDataJSON() as { command: string };
    keys.push({
      command: body.command,
      key: request.headers()['idempotency-key'],
    });
    status = body.command === 'pause' ? 'paused' : 'open';
    if (!lostFirst) {
      lostFirst = true;
      return route.abort();
    }
    return route.fulfill({ json: { session: { status } } });
  });
  await page.goto(url);
  await page.locator('.doctorControls button[aria-pressed]').click();
  await expect(
    page.locator('.doctorControls button[aria-pressed="true"]'),
  ).toBeVisible();
  await page.locator('.doctorControls button[aria-pressed="true"]').click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[0].command).toBe('pause');
  expect(keys[1].command).toBe('resume');
  expect(keys[1].key).not.toBe(keys[0].key);
});
