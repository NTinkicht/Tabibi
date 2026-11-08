import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
// All staff API calls are mocked with page.route; no server session is needed.
const clinicId = '20000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000002';
const id = (n: number) => `20000000-0000-4000-8000-00000000010${n}`;

type S = 'checked_in' | 'waiting' | 'called' | 'in_consultation';
function entry(n: number, state: S, over: Record<string, unknown> = {}) {
  return {
    id: id(n),
    sessionId,
    state,
    registrationOrder: n,
    publicDisplayLabel: `A-0${n}`,
    privateDisplayName: `Patient ${n}`,
    preferredLocale: 'fr',
    hasContact: false,
    eligibilityOrder: state === 'waiting' ? null : n,
    priorityOrder: null,
    origin: 'walk_in',
    appointmentStartsAt: null,
    activeConsultationRemainingMinutes: null,
    eta: null,
    ...over,
  };
}
function snapshot(entries: unknown[], status: 'open' | 'paused' = 'open') {
  return {
    entries,
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

test('console: serving cards, queue order, canonical wait range and reason-gated panel', async ({
  page,
}) => {
  await authenticate(page);
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const entries = [
    entry(1, 'in_consultation', { activeConsultationRemainingMinutes: 7 }),
    entry(2, 'checked_in', { eta: { minWaitMinutes: 10, maxWaitMinutes: 25 } }),
    entry(3, 'waiting'),
  ];
  await page.route('**/api/clinics/**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET')
      return route.fulfill({ json: snapshot(entries) });
    const path = new URL(request.url()).pathname.split('/sessions/')[1]!;
    posts.push({ path, body: request.postDataJSON() });
    return route.fulfill({
      json: path.endsWith('/reorder')
        ? { queueOrderVersion: 2, orderedEntryIds: [] }
        : { entry: { ...entries[1], state: 'called' } },
    });
  });
  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=fr`,
  );
  const serving = page.getByRole('region', { name: 'En cours' });
  await expect(serving).toContainText('A-01');
  await expect(serving).toContainText('≈ 7 min restantes');
  const rows = page.locator('.consoleRow');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('A-02');
  await expect(rows.first()).toContainText('Suivant');
  await expect(rows.first()).toContainText('≈ 10–25 min');
  await expect(rows.nth(1)).toContainText('Pas encore arrivé');

  const more = page.getByRole('button', { name: 'Plus d’actions pour A-02' });
  await more.click();
  const cancel = page.getByRole('button', { name: 'Annuler le passage' });
  await expect(cancel).toBeDisabled();
  await page.getByLabel('Motif opérationnel (obligatoire)').fill('urgence');
  await expect(cancel).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(cancel).toHaveCount(0);

  await more.click();
  await page.getByLabel('Motif opérationnel (obligatoire)').fill('urgence');
  await page.getByRole('button', { name: 'Prioriser' }).click();
  expect(posts.at(-1)?.path).toContain(`queue/${id(2)}/reorder`);
  expect(posts.at(-1)?.body).toMatchObject({
    targetPosition: 1,
    expectedVersion: 1,
    reason: 'urgence',
  });

  await rows
    .first()
    .getByRole('button', { name: 'Appeler', exact: true })
    .click();
  expect(posts.at(-1)?.body.command).toBe('call');
  await expect(page.getByRole('status')).toContainText('A-02 Patient 2');
});

test('console: rejected command shows the error and leaves rows unchanged; paused disables call but not check-in', async ({
  page,
}) => {
  await authenticate(page);
  const entries = [entry(2, 'checked_in'), entry(3, 'waiting')];
  await page.route('**/api/clinics/**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET')
      return route.fulfill({ json: snapshot(entries, 'paused') });
    return route.fulfill({ status: 409, json: { message: 'Stale entry' } });
  });
  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=fr`,
  );
  const rows = page.locator('.consoleRow');
  await expect(
    rows.first().getByRole('button', { name: 'Appeler', exact: true }),
  ).toBeDisabled();
  const checkIn = rows
    .nth(1)
    .getByRole('button', { name: 'Enregistrer l’arrivée' });
  await expect(checkIn).toBeEnabled();
  await checkIn.click();
  await expect(page.locator('.alert')).toContainText('Stale entry');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('Pas encore arrivé');
});
