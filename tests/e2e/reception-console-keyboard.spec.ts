import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
// All staff API calls are mocked with page.route; no server session is needed.
const clinicId = '20000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000002';
const entryId = '20000000-0000-4000-8000-000000000101';

type State = 'waiting' | 'checked_in' | 'called' | 'in_consultation';
type Command =
  | 'check_in'
  | 'call'
  | 'start_consultation'
  | 'complete_consultation';
const NEXT_STATE: Record<Command, State | 'completed'> = {
  check_in: 'checked_in',
  call: 'called',
  start_consultation: 'in_consultation',
  complete_consultation: 'completed',
};

function entry(state: State) {
  return {
    id: entryId,
    sessionId,
    state,
    registrationOrder: 1,
    publicDisplayLabel: 'A-01',
    privateDisplayName: 'Patient 1',
    preferredLocale: 'fr',
    hasContact: false,
    eligibilityOrder: state === 'waiting' ? null : 1,
    priorityOrder: null,
    origin: 'walk_in',
    appointmentStartsAt: null,
    activeConsultationRemainingMinutes: null,
    eta: null,
  };
}

/** Focuses the first control whose accessible label matches, using Tab only. */
async function tabTo(page: Page, name: string) {
  for (let step = 0; step < 80; step += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim();
    });
    if (label === name) return;
  }
  throw new Error(`Could not reach "${name}" with the keyboard`);
}

test('console: keyboard-only check-in, call, start and complete issue one command each', async ({
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
  let current: State | null = 'waiting';
  const commands: Command[] = [];
  await page.route('**/api/clinics/**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      return route.fulfill({
        json: {
          entries: current ? [entry(current)] : [],
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
    const command = request.postDataJSON().command as Command;
    commands.push(command);
    const next = NEXT_STATE[command];
    current = next === 'completed' ? null : next;
    return route.fulfill({
      json: { entry: entry(current ?? 'in_consultation') },
    });
  });
  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=fr`,
  );
  await expect(page.locator('.consoleRow')).toHaveCount(1);

  const steps: Array<[string, Command]> = [
    ['Enregistrer l’arrivée', 'check_in'],
    ['Appeler', 'call'],
    ['Démarrer la consultation', 'start_consultation'],
    ['Terminer la consultation', 'complete_consultation'],
  ];
  for (const [label, command] of steps) {
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await tabTo(page, label);
    await page.keyboard.press('Enter');
    await expect.poll(() => commands.at(-1)).toBe(command);
  }
  expect(commands).toEqual(steps.map(([, command]) => command));
  await expect(page.locator('.consoleRow')).toHaveCount(0);
});
