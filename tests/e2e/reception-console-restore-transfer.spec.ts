import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
// All staff API calls are mocked with page.route; no server session is needed.
const clinicId = '20000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000002';
const otherSessionId = '20000000-0000-4000-8000-000000000003';
const entryId = '20000000-0000-4000-8000-000000000101';

const copy = {
  fr: {
    more: 'Plus d’actions pour A-01',
    noShow: 'Absent',
    cancel: 'Annuler le passage',
    restore: 'Rétablir',
    transfer: 'Transférer',
    target: 'Séance de destination',
    restored: 'rétabli',
    transferred: 'transféré',
  },
  ar: {
    more: 'إجراءات أخرى لـ A-01',
    noShow: 'لم يحضر',
    cancel: 'إلغاء الدور',
    restore: 'استعادة',
    transfer: 'نقل',
    target: 'الجلسة الوجهة',
    restored: 'تمت الاستعادة',
    transferred: 'تم النقل',
  },
} as const;

function entry(state: string, origin = 'walk_in') {
  return {
    id: entryId,
    sessionId,
    state,
    registrationOrder: 1,
    publicDisplayLabel: 'A-01',
    privateDisplayName: 'Patient 1',
    preferredLocale: 'fr',
    hasContact: false,
    eligibilityOrder: 1,
    priorityOrder: null,
    origin,
    appointmentStartsAt: null,
    activeConsultationRemainingMinutes: null,
    eta: null,
  };
}
const snapshot = (entries: unknown[]) => ({
  entries,
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
  timezone: 'UTC',
});
const sessionsList = {
  timezone: 'UTC',
  sessions: [
    {
      id: sessionId,
      doctorDisplayName: 'Dr Leila',
      status: 'open',
      startsAt: '2026-09-08T09:00:00.000Z',
      endsAt: '2026-09-08T12:00:00.000Z',
    },
    {
      id: otherSessionId,
      doctorDisplayName: 'Dr Leila',
      status: 'planned',
      startsAt: '2026-09-08T14:00:00.000Z',
      endsAt: '2026-09-08T17:00:00.000Z',
    },
    {
      id: '20000000-0000-4000-8000-000000000004',
      doctorDisplayName: 'Dr Leila',
      status: 'closed',
      startsAt: '2026-09-08T05:00:00.000Z',
      endsAt: '2026-09-08T07:00:00.000Z',
    },
    {
      id: '20000000-0000-4000-8000-000000000005',
      doctorDisplayName: 'Dr Karim',
      status: 'open',
      startsAt: '2026-09-08T09:00:00.000Z',
      endsAt: '2026-09-08T12:00:00.000Z',
    },
  ],
};
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

type Post = { path: string; body: Record<string, unknown> };
async function mockApi(
  page: Page,
  options: {
    entries: () => unknown[];
    onPost: (
      path: string,
      body: Record<string, unknown>,
    ) => { status: number; json: unknown };
  },
  posts: Post[],
) {
  await page.route('**/api/clinics/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET')
      return route.fulfill({
        json: url.pathname.endsWith('/dashboard')
          ? snapshot(options.entries())
          : sessionsList,
      });
    const path = url.pathname.split('/sessions/')[1]!;
    const body = request.postDataJSON() as Record<string, unknown>;
    posts.push({ path, body });
    return route.fulfill(options.onPost(path, body));
  });
}

for (const locale of ['fr', 'ar'] as const) {
  const c = copy[locale];
  for (const [action, state] of [
    ['noShow', 'no_show'],
    ['cancel', 'cancelled'],
  ] as const) {
    test(`console ${locale}: Restore reverts the ${state} shown in the status bar`, async ({
      page,
    }) => {
      await authenticate(page);
      const posts: Post[] = [];
      let current = 'checked_in';
      await mockApi(
        page,
        {
          entries: () => [entry(current)],
          onPost: (path) => {
            if (path.endsWith('/restore')) current = 'waiting';
            else current = state;
            return { status: 200, json: { entry: entry(current) } };
          },
        },
        posts,
      );
      page.on('dialog', (dialog) => void dialog.accept());
      await page.goto(
        `/operations/${clinicId}/sessions/${sessionId}/queue?locale=${locale}`,
      );
      await page.getByRole('button', { name: c.more }).click();
      await page.locator('.rowPanel input').fill('erreur');
      await page.getByRole('button', { name: c[action] }).click();
      const bar = page.locator('.lastAction');
      await expect(bar).toContainText('A-01 Patient 1');
      const restore = bar.getByRole('button', { name: c.restore });
      await expect(restore).toBeDisabled();
      await bar.locator('input').fill('retour');
      await expect(restore).toBeEnabled();
      await restore.click();
      await expect(bar).toContainText(c.restored);
      await expect(restore).toHaveCount(0);
      const post = posts.at(-1)!;
      expect(post.path).toBe(`${sessionId}/queue/${entryId}/restore`);
      expect(post.body).toEqual({ reason: 'retour', checkIn: false });
    });
  }

  test(`console ${locale}: rejected restore keeps the entry and the Restore button`, async ({
    page,
  }) => {
    await authenticate(page);
    const posts: Post[] = [];
    let current = 'checked_in';
    await mockApi(
      page,
      {
        entries: () => [entry(current)],
        onPost: (path) => {
          if (path.endsWith('/restore'))
            return { status: 409, json: { message: 'Stale entry' } };
          current = 'no_show';
          return { status: 200, json: { entry: entry(current) } };
        },
      },
      posts,
    );
    await page.goto(
      `/operations/${clinicId}/sessions/${sessionId}/queue?locale=${locale}`,
    );
    await page.getByRole('button', { name: c.more }).click();
    await page.locator('.rowPanel input').fill('erreur');
    await page.getByRole('button', { name: c.noShow }).click();
    const bar = page.locator('.lastAction');
    await bar.locator('input').fill('retour');
    await bar.getByRole('button', { name: c.restore }).click();
    await expect(page.locator('.alert')).toContainText('Stale entry');
    await expect(bar.getByRole('button', { name: c.restore })).toBeVisible();
    expect(current).toBe('no_show');
  });

  test(`console ${locale}: Transfer needs a reason and an eligible target of the same doctor`, async ({
    page,
  }) => {
    await authenticate(page);
    const posts: Post[] = [];
    let current = 'checked_in';
    await mockApi(
      page,
      {
        entries: () => (current === 'cancelled' ? [] : [entry(current)]),
        onPost: () => {
          current = 'cancelled';
          return { status: 200, json: { result: {} } };
        },
      },
      posts,
    );
    await page.goto(
      `/operations/${clinicId}/sessions/${sessionId}/queue?locale=${locale}`,
    );
    await page.getByRole('button', { name: c.more }).click();
    const select = page.locator('.rowPanel select');
    // Only the planned session of the same doctor is offered: the current,
    // closed and other-doctor sessions are not.
    await expect(select.locator('option')).toHaveCount(2);
    await expect(select.locator('option').nth(1)).toHaveAttribute(
      'value',
      otherSessionId,
    );
    const transfer = page.getByRole('button', {
      name: c.transfer,
      exact: true,
    });
    await expect(transfer).toBeDisabled();
    await page.locator('.rowPanel input').fill('autre créneau');
    await expect(transfer).toBeDisabled();
    await select.selectOption(otherSessionId);
    await expect(transfer).toBeEnabled();
    await transfer.click();
    await expect(page.locator('.lastAction')).toContainText(c.transferred);
    await expect(page.locator('.lastAction').getByRole('button')).toHaveCount(
      0,
    );
    const post = posts.at(-1)!;
    expect(post.path).toBe(`${sessionId}/queue/${entryId}/transfer`);
    expect(post.body).toEqual({
      reason: 'autre créneau',
      targetSessionId: otherSessionId,
    });
  });
}

test('console: appointment-backed entries get neither Transfer nor Restore', async ({
  page,
}) => {
  await authenticate(page);
  const posts: Post[] = [];
  let current = 'checked_in';
  await mockApi(
    page,
    {
      entries: () => [entry(current, 'appointment')],
      onPost: () => {
        current = 'no_show';
        return { status: 200, json: { entry: entry(current, 'appointment') } };
      },
    },
    posts,
  );
  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=fr`,
  );
  await page.getByRole('button', { name: copy.fr.more }).click();
  await expect(page.locator('.rowPanel select')).toHaveCount(0);
  await page.locator('.rowPanel input').fill('absent');
  await page.getByRole('button', { name: 'Absent' }).click();
  await expect(page.locator('.lastAction')).toContainText('A-01 Patient 1');
  await expect(page.locator('.lastAction').getByRole('button')).toHaveCount(0);
});

test('console: prioritising another entry clears the Restore target', async ({
  page,
}) => {
  await authenticate(page);
  const posts: Post[] = [];
  const secondId = '20000000-0000-4000-8000-000000000102';
  let first = 'checked_in';
  const second = () => ({
    ...entry('checked_in'),
    id: secondId,
    publicDisplayLabel: 'A-02',
    privateDisplayName: 'Patient 2',
    registrationOrder: 2,
    eligibilityOrder: 2,
  });
  await mockApi(
    page,
    {
      entries: () => [entry(first), second()],
      onPost: (path) => {
        if (path.endsWith('/reorder'))
          return {
            status: 200,
            json: { queueOrderVersion: 2, orderedEntryIds: [secondId] },
          };
        first = 'no_show';
        return { status: 200, json: { entry: entry(first) } };
      },
    },
    posts,
  );
  await page.goto(
    `/operations/${clinicId}/sessions/${sessionId}/queue?locale=fr`,
  );
  await page.getByRole('button', { name: copy.fr.more }).click();
  await page.locator('.rowPanel input').fill('absent');
  await page.getByRole('button', { name: 'Absent' }).click();
  const bar = page.locator('.lastAction');
  await expect(
    bar.getByRole('button', { name: copy.fr.restore }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Plus d’actions pour A-02' }).click();
  await page.locator('.rowPanel input').fill('urgence');
  await page.getByRole('button', { name: 'Prioriser' }).click();
  await expect(bar).toContainText('A-02');
  await expect(bar.getByRole('button', { name: copy.fr.restore })).toHaveCount(
    0,
  );
});
