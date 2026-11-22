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

const copy = {
  fr: {
    serving: 'En cours',
    remaining: '≈ 7 min restantes',
    next: 'Suivant',
    range: '≈ 10–25 min',
    notArrived: 'Pas encore arrivé',
    more: 'Plus d’actions pour A-02',
    cancel: 'Annuler le passage',
    reason: 'Motif opérationnel (obligatoire)',
    prioritise: 'Prioriser',
    call: 'Appeler',
    checkIn: 'Enregistrer l’arrivée',
    dir: 'ltr',
  },
  ar: {
    serving: 'الجارية الآن',
    remaining: '≈ 7 دقيقة متبقية',
    next: 'التالي',
    range: '≈ 10–25 دقيقة',
    notArrived: 'لم يصل بعد',
    more: 'إجراءات أخرى لـ A-02',
    cancel: 'إلغاء الدور',
    reason: 'السبب التشغيلي (مطلوب)',
    prioritise: 'تقديم',
    call: 'نداء',
    checkIn: 'تسجيل الوصول',
    dir: 'rtl',
  },
} as const;

for (const locale of ['fr', 'ar'] as const) {
  test(`console ${locale}: serving cards, queue order, canonical wait range and reason-gated panel`, async ({
    page,
  }) => {
    const c = copy[locale];
    await authenticate(page);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const entries = [
      entry(1, 'in_consultation', { activeConsultationRemainingMinutes: 7 }),
      entry(2, 'checked_in', {
        eta: { minWaitMinutes: 10, maxWaitMinutes: 25 },
      }),
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
      `/operations/${clinicId}/sessions/${sessionId}/queue?locale=${locale}`,
    );
    await expect(page.locator('main.desk')).toHaveAttribute('dir', c.dir);
    const serving = page.getByRole('region', { name: c.serving });
    await expect(serving).toContainText('A-01');
    await expect(serving).toContainText(c.remaining);
    const rows = page.locator('.consoleRow');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('A-02');
    await expect(rows.first()).toContainText(c.next);
    await expect(rows.first()).toContainText(c.range);
    await expect(rows.nth(1)).toContainText(c.notArrived);

    const more = page.getByRole('button', { name: c.more });
    await more.click();
    const cancel = page.getByRole('button', { name: c.cancel });
    await expect(cancel).toBeDisabled();
    await page.getByLabel(c.reason).fill('urgence');
    await expect(cancel).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(cancel).toHaveCount(0);

    await more.click();
    await page.getByLabel(c.reason).fill('urgence');
    await page.getByRole('button', { name: c.prioritise }).click();
    expect(posts.at(-1)?.path).toContain(`queue/${id(2)}/reorder`);
    expect(posts.at(-1)?.body).toMatchObject({
      targetPosition: 1,
      expectedVersion: 1,
      reason: 'urgence',
    });

    await rows
      .first()
      .getByRole('button', { name: c.call, exact: true })
      .click();
    expect(posts.at(-1)?.body.command).toBe('call');
    await expect(page.getByRole('status')).toContainText('A-02 Patient 2');
  });

  test(`console ${locale}: rejected command shows the error and leaves rows unchanged; paused disables call but not check-in`, async ({
    page,
  }) => {
    const c = copy[locale];
    await authenticate(page);
    const entries = [entry(2, 'checked_in'), entry(3, 'waiting')];
    await page.route('**/api/clinics/**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET')
        return route.fulfill({ json: snapshot(entries, 'paused') });
      return route.fulfill({ status: 409, json: { message: 'Stale entry' } });
    });
    await page.goto(
      `/operations/${clinicId}/sessions/${sessionId}/queue?locale=${locale}`,
    );
    const rows = page.locator('.consoleRow');
    await expect(
      rows.first().getByRole('button', { name: c.call, exact: true }),
    ).toBeDisabled();
    const checkIn = rows.nth(1).getByRole('button', { name: c.checkIn });
    await expect(checkIn).toBeEnabled();
    await checkIn.click();
    await expect(page.locator('.alert')).toContainText('Stale entry');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText(c.notArrived);
  });
}
