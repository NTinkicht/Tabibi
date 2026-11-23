import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { accountStrings } from '@/app/account/strings';
import { issuePatientPasswordReset } from '@/modules/identity/patient-recovery';

const PASSWORD = 'correct horse battery staple 959';

async function sessionStatus(page: Page): Promise<number> {
  return page.evaluate(
    async () => (await fetch('/api/patient/session')).status,
  );
}

async function mockNoVisits(page: Page): Promise<void> {
  await page.route('**/api/patient/visits**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ visits: [], nextCursor: null }),
    }),
  );
}

const NEW_PASSWORD = 'another long passphrase value 961';

async function signInStatus(
  page: Page,
  email: string,
  password: string,
): Promise<number> {
  return page.evaluate(
    async ([e, p]) =>
      (
        await fetch('/api/patient/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: e, password: p }),
        })
      ).status,
    [email, password],
  );
}

test('account strings have identical keys in both locales', () => {
  expect(Object.keys(accountStrings.fr).sort()).toEqual(
    Object.keys(accountStrings.ar).sort(),
  );
});

for (const [locale, dir] of [
  ['fr', 'ltr'],
  ['ar', 'rtl'],
] as const) {
  test(`patient account ${locale}: lang/dir, labels, mobile, error focus`, async ({
    page,
  }) => {
    const t = accountStrings[locale];
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/account?locale=${locale}`);
    const main = page.getByTestId('patient-account');
    await expect(main).toHaveAttribute('lang', locale);
    await expect(main).toHaveAttribute('dir', dir);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.title);
    await expect(page.locator('#account-email')).toHaveAttribute(
      'autocomplete',
      'username',
    );
    await expect(page.locator('#account-password')).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.locator('#account-email').fill(`nobody-${randomUUID()}@x.test`);
    await page.locator('#account-password').fill('wrong password value');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('account-error')).toBeFocused();
    await expect(page.getByTestId('account-error')).toContainText(t.failed);
    expect(page.url()).not.toContain('password');
  });
}

test('session check failure is not shown as signed out and can be retried', async ({
  page,
}) => {
  const t = accountStrings.fr;
  let calls = 0;
  await page.route('**/api/patient/session', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    calls += 1;
    if (calls === 1) return route.fulfill({ status: 503, body: '{}' });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ account: { displayName: 'Amel' } }),
    });
  });
  await page.route('**/api/patient/dependents', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ dependents: [] }),
    }),
  );
  await mockNoVisits(page);
  await page.route('**/api/patient/saved-doctors', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ doctors: [] }),
    }),
  );
  await page.goto('/account?locale=fr');
  await expect(page.getByTestId('account-session-error')).toContainText(
    t.unavailable,
  );
  await expect(page.locator('#account-email')).toHaveCount(0);
  await page.getByRole('button', { name: t.retry }).click();
  await expect(page.getByTestId('account-signed-in')).toContainText('Amel');
});

test('register, sign in, see the name, sign out', async ({ page }) => {
  const email = `account-${randomUUID()}@example.test`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await page.goto('/account?locale=fr');
    await page.getByRole('button', { name: 'Créer un compte' }).click();
    await page.locator('#account-email').fill(email);
    await page.locator('#account-name').fill('Amina Test');
    await page.locator('#account-password').fill('short');
    await page.getByRole('button', { name: 'Créer le compte' }).click();
    await expect(page.getByTestId('account-error')).toContainText(
      accountStrings.fr.invalid,
    );

    await page.locator('#account-password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Créer le compte' }).click();
    await expect(page.getByTestId('account-notice')).toBeVisible();

    await page.locator('#account-email').fill(email);
    await page.locator('#account-password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Se connecter' }).last().click();
    const signedIn = page.getByTestId('account-signed-in');
    await expect(signedIn).toContainText('Amina Test');
    expect(await sessionStatus(page)).toBe(200);

    await page.reload();
    await expect(page.getByTestId('account-signed-in')).toContainText(
      'Amina Test',
    );
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page.locator('#account-email')).toBeVisible();
    expect(await sessionStatus(page)).toBe(401);
  } finally {
    await pool.query(
      `DELETE FROM users WHERE auth_subject = 'patient:' || $1`,
      [email],
    );
    await pool.end();
  }
});

for (const locale of ['fr', 'ar'] as const) {
  test(`password change ${locale}: wrong current and policy refused, success rotates`, async ({
    page,
  }) => {
    const t = accountStrings[locale];
    const email = `pw-${randomUUID()}@example.test`;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await page.goto(`/account?locale=${locale}`);
      const registered = await page.evaluate(
        async ([e, p]) =>
          (
            await fetch('/api/patient/register', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                email: e,
                password: p,
                displayName: 'Pw Test',
              }),
            })
          ).status,
        [email, PASSWORD],
      );
      expect(registered).toBeLessThan(300);
      expect(await signInStatus(page, email, PASSWORD)).toBe(200);
      await page.reload();
      const panel = page.getByTestId('password-change');
      await expect(panel).toBeVisible();
      await expect(page.locator('#account-current-password')).toHaveAttribute(
        'autocomplete',
        'current-password',
      );
      await expect(page.locator('#account-new-password')).toHaveAttribute(
        'autocomplete',
        'new-password',
      );

      await page.locator('#account-current-password').fill('not the password');
      await page.locator('#account-new-password').fill(NEW_PASSWORD);
      await page.getByRole('button', { name: t.changePassword }).click();
      await expect(page.getByTestId('password-error')).toContainText(
        t.wrongCurrent,
      );
      await expect(page.getByTestId('password-error')).toBeFocused();
      expect(await signInStatus(page, email, PASSWORD)).toBe(200);
      expect(await signInStatus(page, email, NEW_PASSWORD)).toBe(401);

      await page.locator('#account-current-password').fill(PASSWORD);
      await page.locator('#account-new-password').fill('short');
      await page.getByRole('button', { name: t.changePassword }).click();
      await expect(page.getByTestId('password-error')).toContainText(t.policy);
      expect(await signInStatus(page, email, PASSWORD)).toBe(200);

      await page.locator('#account-current-password').fill(PASSWORD);
      await page.locator('#account-new-password').fill(NEW_PASSWORD);
      await page.getByRole('button', { name: t.changePassword }).click();
      await expect(page.getByTestId('password-notice')).toContainText(
        t.passwordChanged,
      );
      await expect(page.locator('#account-new-password')).toHaveValue('');
      expect(await signInStatus(page, email, PASSWORD)).toBe(401);
      expect(await signInStatus(page, email, NEW_PASSWORD)).toBe(200);
      expect(page.url()).not.toContain('password');
    } finally {
      await pool.query(
        `DELETE FROM users WHERE auth_subject = 'patient:' || $1`,
        [email],
      );
      await pool.end();
    }
  });
}

for (const locale of ['fr', 'ar'] as const) {
  test(`password reset link ${locale}: fragment removed, bad token neutral, policy keeps token, success signs in`, async ({
    page,
  }) => {
    const t = accountStrings[locale];
    const email = `reset-${randomUUID()}@example.test`;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await page.goto(`/account?locale=${locale}`);
      const registered = await page.evaluate(
        async ([e, p]) =>
          (
            await fetch('/api/patient/register', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                email: e,
                password: p,
                displayName: 'Reset Test',
              }),
            })
          ).status,
        [email, PASSWORD],
      );
      expect(registered).toBeLessThan(300);

      // No token, or a query-string token: neutral refusal, no form.
      await page.goto(`/account/reset?locale=${locale}&token=abc`);
      await expect(page.getByTestId('patient-reset')).toHaveAttribute(
        'lang',
        locale,
      );
      await expect(page.getByTestId('reset-error')).toContainText(
        t.resetInvalidToken,
      );
      await expect(page.locator('#reset-new-password')).toHaveCount(0);

      // A well-formed but unknown token is refused with the same message.
      const unknown = randomBytes(32).toString('base64url');
      await page.goto(`/account/reset?locale=${locale}#${unknown}`);
      await page.locator('#reset-new-password').fill(NEW_PASSWORD);
      await page.getByRole('button', { name: t.resetSubmit }).click();
      await expect(page.getByTestId('reset-error')).toContainText(
        t.resetInvalidToken,
      );
      await expect(page.getByTestId('reset-error')).toBeFocused();

      // Issue a real token the way the operator command does.
      const issued = await issuePatientPasswordReset(pool, email, {
        label: 'test-operator',
      });
      expect(issued).not.toBeNull();
      // Pasting a replacement link into the same page changes only the
      // fragment (no reload): the invalid-link screen must recover.
      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, issued!.token);
      await expect(page.locator('#reset-new-password')).toBeVisible();
      await expect.poll(() => page.url()).not.toContain(issued!.token);
      expect(await page.content()).not.toContain(issued!.token);

      // A response to a superseded link must not overwrite the replacement
      // link's state: hold a request made with another token, switch to the
      // issued link, then release it.
      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, randomBytes(32).toString('base64url'));
      await expect(page.locator('#reset-new-password')).toBeVisible();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const redeemPath = '**/api/patient/recovery/redeem';
      await page.route(redeemPath, async (route) => {
        await gate;
        await route.continue();
      });
      await page.locator('#reset-new-password').fill(NEW_PASSWORD);
      await page.getByRole('button', { name: t.resetSubmit }).click();
      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, issued!.token);
      const stale = page.waitForResponse((r) => r.url().includes('/redeem'));
      release();
      await stale;
      await page.unroute(redeemPath);
      await expect(page.getByTestId('reset-error')).toHaveCount(0);
      await expect(page.locator('#reset-new-password')).toBeVisible();
      await page.locator('#reset-new-password').fill('');

      // An empty password is rejected by the schema (400 invalid_request):
      // the form must stay available and the token usable.
      await page.getByRole('button', { name: t.resetSubmit }).click();
      await expect(page.getByTestId('reset-error')).toContainText(
        t.resetPolicy,
      );
      await expect(page.locator('#reset-new-password')).toBeVisible();

      await page.locator('#reset-new-password').fill('short');
      await page.getByRole('button', { name: t.resetSubmit }).click();
      await expect(page.getByTestId('reset-error')).toContainText(
        t.resetPolicy,
      );
      expect(await signInStatus(page, email, PASSWORD)).toBe(200);

      // The policy failure left the token usable.
      await page.locator('#reset-new-password').fill(NEW_PASSWORD);
      await page.getByRole('button', { name: t.resetSubmit }).click();
      await expect(page.getByTestId('reset-notice')).toContainText(t.resetDone);
      expect(await signInStatus(page, email, PASSWORD)).toBe(401);
      expect(await signInStatus(page, email, NEW_PASSWORD)).toBe(200);
    } finally {
      await pool.query(
        `DELETE FROM users WHERE auth_subject = 'patient:' || $1`,
        [email],
      );
      await pool.end();
    }
  });
}

for (const locale of ['fr', 'ar'] as const) {
  test(`dependents ${locale}: add, rename, archive, signed-out on 401`, async ({
    page,
  }) => {
    const t = accountStrings[locale];
    const email = `deps-${randomUUID()}@example.test`;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await page.goto(`/account?locale=${locale}`);
      const statuses = await page.evaluate(
        async ([e, p]) => {
          const json = { 'content-type': 'application/json' };
          const registered = await fetch('/api/patient/register', {
            method: 'POST',
            headers: json,
            body: JSON.stringify({
              email: e,
              password: p,
              displayName: 'Nour',
            }),
          });
          const signedIn = await fetch('/api/patient/session', {
            method: 'POST',
            headers: json,
            body: JSON.stringify({ email: e, password: p }),
          });
          return [registered.status, signedIn.status];
        },
        [email, PASSWORD],
      );
      expect(statuses[1]).toBe(200);
      await page.reload();
      const section = page.getByTestId('dependents');
      await expect(section.getByRole('heading', { level: 2 })).toHaveText(
        t.dependentsTitle,
      );
      await expect(page.getByTestId('dependents-empty')).toContainText(
        t.dependentsEmpty,
      );

      await page.locator('#dependent-new-name').fill('   ');
      await section.getByRole('button', { name: t.dependentAdd }).click();
      await expect(page.getByTestId('dependents-error')).toBeFocused();
      await expect(page.getByTestId('dependents-error')).toContainText(
        t.dependentInvalid,
      );

      await page.locator('#dependent-new-name').fill('Yanis');
      await section.getByRole('button', { name: t.dependentAdd }).click();
      const rows = page.getByTestId('dependent-row');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText('Yanis');
      await expect(page.locator('#dependent-new-name')).toHaveValue('');
      await expect(page.getByTestId('dependents-error')).toHaveCount(0);

      await rows.first().getByRole('button', { name: /Yanis/ }).first().click();
      const edit = rows.first().locator('input[name="displayName"]');
      await expect(edit).toBeFocused();
      await edit.fill('Yanis B');
      await rows.first().getByRole('button', { name: t.dependentSave }).click();
      await expect(rows.first()).toContainText('Yanis B');

      await rows
        .first()
        .getByRole('button', { name: `${t.dependentArchive} Yanis B` })
        .click();
      await expect(page.getByTestId('dependents-empty')).toBeVisible();

      await page.route('**/api/patient/dependents', (route) =>
        route.fulfill({ status: 401, body: '{}' }),
      );
      await page.locator('#dependent-new-name').fill('Lina');
      await section.getByRole('button', { name: t.dependentAdd }).click();
      await expect(page.locator('#account-email')).toBeVisible();
      await expect(page.getByTestId('account-signed-in')).toHaveCount(0);
    } finally {
      await pool.query(
        `DELETE FROM patient_dependents WHERE owner_user_id IN
           (SELECT id FROM users WHERE auth_subject = 'patient:' || $1)`,
        [email],
      );
      await pool.query(
        `DELETE FROM users WHERE auth_subject = 'patient:' || $1`,
        [email],
      );
      await pool.end();
    }
  });
}

test('dependents list failure is retryable and not shown as empty', async ({
  page,
}) => {
  const t = accountStrings.fr;
  await page.route('**/api/patient/session', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ account: { displayName: 'Amel' } }),
        })
      : route.continue(),
  );
  await mockNoVisits(page);
  await page.route('**/api/patient/saved-doctors', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ doctors: [] }),
    }),
  );
  let calls = 0;
  await page.route('**/api/patient/dependents', (route) => {
    calls += 1;
    return calls === 1
      ? route.fulfill({ status: 503, body: '{}' })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            dependents: [{ id: 'd1', displayName: 'Sara' }],
          }),
        });
  });
  await page.goto('/account?locale=fr');
  await expect(page.getByTestId('dependents-load-error')).toBeVisible();
  await expect(page.getByTestId('dependents-empty')).toHaveCount(0);
  await page
    .getByTestId('dependents-load-error')
    .getByRole('button', { name: t.retry })
    .click();
  await expect(page.getByTestId('dependent-row')).toContainText('Sara');
});

for (const locale of ['fr', 'ar'] as const) {
  test(`saved doctors ${locale}: list, remove, load retry, signed-out on 401`, async ({
    page,
  }) => {
    const t = accountStrings[locale];
    const clinicId = randomUUID();
    const doctorId = randomUUID();
    let doctors = [
      {
        clinicId,
        clinicName: 'Cabinet Amel',
        doctorId,
        displayName: 'Dr Karim',
        savedAt: '2026-11-20T09:00:00.000Z',
      },
    ];
    const deletes: string[] = [];
    let listCalls = 0;
    let failDelete = false;
    let unauthorized = false;
    await page.route('**/api/patient/session', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ account: { displayName: 'Amel' } }),
          })
        : route.continue(),
    );
    await page.route('**/api/patient/dependents', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ dependents: [] }),
      }),
    );
    await mockNoVisits(page);
    await page.route('**/api/patient/saved-doctors', (route) => {
      listCalls += 1;
      if (unauthorized) return route.fulfill({ status: 401, body: '{}' });
      if (listCalls === 1) return route.fulfill({ status: 503, body: '{}' });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ doctors }),
      });
    });
    await page.route('**/api/patient/saved-doctors/*/*', (route) => {
      deletes.push(
        `${route.request().method()} ${new URL(route.request().url()).pathname}`,
      );
      if (unauthorized) return route.fulfill({ status: 401, body: '{}' });
      if (failDelete) return route.fulfill({ status: 503, body: '{}' });
      doctors = [];
      return route.fulfill({ status: 204 });
    });

    await page.goto(`/account?locale=${locale}`);
    const section = page.getByTestId('saved-doctors');
    await expect(section.getByRole('heading', { level: 2 })).toHaveText(
      t.savedDoctorsTitle,
    );
    await expect(page.getByTestId('saved-doctors-load-error')).toContainText(
      t.unavailable,
    );
    await section.getByRole('button', { name: t.retry }).click();
    const rows = page.getByTestId('saved-doctor-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Dr Karim');
    await expect(rows.first()).toContainText('Cabinet Amel');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    const remove = rows
      .first()
      .getByRole('button', { name: `${t.savedDoctorRemove} Dr Karim` });
    failDelete = true;
    await remove.click();
    await expect(page.getByTestId('saved-doctors-error')).toBeFocused();
    await expect(page.getByTestId('saved-doctors-error')).toContainText(
      t.unavailable,
    );
    await expect(rows).toHaveCount(1);

    failDelete = false;
    await remove.click();
    await expect(page.getByTestId('saved-doctors-empty')).toContainText(
      t.savedDoctorsEmpty,
    );
    await expect(page.getByTestId('saved-doctors-error')).toHaveCount(0);
    expect(deletes).toEqual([
      `DELETE /api/patient/saved-doctors/${clinicId}/${doctorId}`,
      `DELETE /api/patient/saved-doctors/${clinicId}/${doctorId}`,
    ]);

    unauthorized = true;
    await page.reload();
    await expect(page.locator('#account-email')).toBeVisible();
    await expect(page.getByTestId('account-signed-in')).toHaveCount(0);
  });
}

for (const locale of ['fr', 'ar'] as const) {
  test(`visits ${locale}: list, load more, cancel confirm, conflict, failure, signed-out on 401`, async ({
    page,
  }) => {
    const t = accountStrings[locale];
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const visit = (
      appointmentId: string,
      status: string,
      doctorDisplayName: string,
      dependentId: string | null = null,
    ) => ({
      appointmentId,
      clinicId: randomUUID(),
      clinicName: 'Cabinet Amel',
      doctorId: randomUUID(),
      doctorDisplayName,
      scheduledStartAt: '2026-12-01T08:30:00.000Z',
      scheduledEndAt: '2026-12-01T09:00:00.000Z',
      status,
      dependentId,
    });
    const state = {
      first: [
        visit(ids[0]!, 'confirmed', 'Dr Karim'),
        visit(ids[1]!, 'completed', 'Dr Yasmine', randomUUID()),
      ],
      second: [visit(ids[2]!, 'booked', 'Dr Omar')],
    };
    const requests: string[] = [];
    let listCalls = 0;
    let failRefresh = false;
    let cancelStatus = 503;
    let unauthorized = false;
    await page.route('**/api/patient/session', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ account: { displayName: 'Amel' } }),
          })
        : route.continue(),
    );
    for (const path of ['dependents', 'saved-doctors'])
      await page.route(`**/api/patient/${path}`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            path === 'dependents' ? { dependents: [] } : { doctors: [] },
          ),
        }),
      );
    await page.route('**/api/patient/visits?*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ visits: state.second, nextCursor: null }),
      }),
    );
    await page.route('**/api/patient/visits', (route) => {
      listCalls += 1;
      if (unauthorized) return route.fulfill({ status: 401, body: '{}' });
      if (listCalls === 1 || failRefresh)
        return route.fulfill({ status: 503, body: '{}' });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ visits: state.first, nextCursor: 'cursor-2' }),
      });
    });
    await page.route('**/api/patient/visits/*/cancel', (route) => {
      requests.push(
        `${route.request().method()} ${new URL(route.request().url()).pathname}`,
      );
      if (cancelStatus === 200) {
        state.first[0] = { ...state.first[0]!, status: 'cancelled' };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ appointmentId: ids[0], status: 'cancelled' }),
        });
      }
      return route.fulfill({ status: cancelStatus, body: '{}' });
    });

    await page.goto(`/account?locale=${locale}`);
    const section = page.getByTestId('visits');
    await expect(section.getByRole('heading', { level: 2 })).toHaveText(
      t.visitsTitle,
    );
    await expect(page.getByTestId('visits-load-error')).toContainText(
      t.unavailable,
    );
    await section.getByRole('button', { name: t.retry }).click();
    const rows = page.getByTestId('visit-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Dr Karim');
    await expect(rows.nth(0)).toContainText('Cabinet Amel');
    await expect(rows.nth(0).getByTestId('visit-status')).toHaveText(
      t.visitStatus.confirmed,
    );
    await expect(rows.nth(0)).not.toContainText(t.visitForRelative);
    await expect(rows.nth(1)).toContainText(t.visitForRelative);
    await expect(rows.nth(1).getByRole('button')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    await section.getByRole('button', { name: t.visitsMore }).click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText('Dr Omar');
    await expect(
      section.getByRole('button', { name: t.visitsMore }),
    ).toHaveCount(0);

    const open = rows
      .nth(0)
      .getByRole('button', { name: new RegExp(`^${t.visitCancel}`) });
    await open.click();
    await rows.nth(0).getByRole('button', { name: t.visitCancelKeep }).click();
    expect(requests).toEqual([]);
    await open.click();
    const confirm = rows
      .nth(0)
      .getByRole('button', { name: new RegExp(`^${t.visitCancelConfirm}`) });
    await confirm.click();
    await expect(page.getByTestId('visits-error')).toBeFocused();
    await expect(page.getByTestId('visits-error')).toContainText(t.unavailable);
    await expect(rows.nth(0).getByTestId('visit-status')).toHaveText(
      t.visitStatus.confirmed,
    );

    cancelStatus = 409;
    await confirm.click();
    await expect(page.getByTestId('visits-error')).toContainText(
      t.visitCancelConflict,
    );

    cancelStatus = 200;
    failRefresh = true;
    await rows
      .nth(0)
      .getByRole('button', { name: new RegExp(`^${t.visitCancel}`) })
      .click();
    await rows
      .nth(0)
      .getByRole('button', { name: new RegExp(`^${t.visitCancelConfirm}`) })
      .click();
    await expect(rows.nth(0).getByTestId('visit-status')).toHaveText(
      t.visitStatus.cancelled,
    );
    // The refresh failed: the row must still be cancelled, offer no cancel
    // control, and a retry must be available.
    await expect(page.getByTestId('visits-more-error')).toBeVisible();
    await expect(rows.nth(0).getByRole('button')).toHaveCount(0);
    failRefresh = false;
    await page
      .getByTestId('visits-more-error')
      .getByRole('button', { name: t.retry })
      .click();
    await expect(page.getByTestId('visits-more-error')).toHaveCount(0);
    await expect(rows.nth(0).getByTestId('visit-status')).toHaveText(
      t.visitStatus.cancelled,
    );
    await expect(page.getByTestId('visits-error')).toHaveCount(0);
    expect(requests).toEqual([
      `POST /api/patient/visits/${ids[0]}/cancel`,
      `POST /api/patient/visits/${ids[0]}/cancel`,
      `POST /api/patient/visits/${ids[0]}/cancel`,
    ]);

    unauthorized = true;
    await page.reload();
    await expect(page.locator('#account-email')).toBeVisible();
    await expect(page.getByTestId('account-signed-in')).toHaveCount(0);
  });
}

for (const locale of ['fr', 'ar'] as const) {
  test(`visits ${locale}: a load-more started before a refresh is discarded`, async ({
    page,
  }) => {
    const t = accountStrings[locale];
    const id = randomUUID();
    const row = (appointmentId: string, status: string, name: string) => ({
      appointmentId,
      clinicId: randomUUID(),
      clinicName: 'Cabinet Amel',
      doctorId: randomUUID(),
      doctorDisplayName: name,
      scheduledStartAt: '2026-12-01T08:30:00.000Z',
      scheduledEndAt: '2026-12-01T09:00:00.000Z',
      status,
      dependentId: null,
    });
    let releaseRefresh!: () => void;
    let releaseMore!: () => void;
    const refreshGate = new Promise<void>((r) => (releaseRefresh = r));
    const moreGate = new Promise<void>((r) => (releaseMore = r));
    let listCalls = 0;
    let moreRequested = false;
    let moreAnswered = false;
    const json = (body: unknown) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    await page.route('**/api/patient/session', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill(json({ account: { displayName: 'Amel' } }))
        : route.continue(),
    );
    await page.route('**/api/patient/dependents', (route) =>
      route.fulfill(json({ dependents: [] })),
    );
    await page.route('**/api/patient/saved-doctors', (route) =>
      route.fulfill(json({ doctors: [] })),
    );
    await page.route('**/api/patient/visits?*', async (route) => {
      moreRequested = true;
      await moreGate;
      moreAnswered = true;
      return route.fulfill(
        json({
          visits: [row(randomUUID(), 'booked', 'Dr Omar')],
          nextCursor: null,
        }),
      );
    });
    await page.route('**/api/patient/visits', async (route) => {
      listCalls += 1;
      if (listCalls === 2) await refreshGate;
      return route.fulfill(
        json({
          visits: [
            row(id, listCalls === 1 ? 'confirmed' : 'cancelled', 'Dr Karim'),
          ],
          nextCursor: 'cursor-2',
        }),
      );
    });
    await page.route('**/api/patient/visits/*/cancel', (route) =>
      route.fulfill(json({ appointmentId: id, status: 'cancelled' })),
    );

    await page.goto(`/account?locale=${locale}`);
    const rows = page.getByTestId('visit-row');
    await expect(rows).toHaveCount(1);
    await rows
      .first()
      .getByRole('button', { name: new RegExp(`^${t.visitCancel}`) })
      .click();
    await rows
      .first()
      .getByRole('button', { name: new RegExp(`^${t.visitCancelConfirm}`) })
      .click();
    await expect(rows.first().getByTestId('visit-status')).toHaveText(
      t.visitStatus.cancelled,
    );
    // The refresh is still in flight; paginating now uses the stale cursor.
    await page
      .getByTestId('visits')
      .getByRole('button', { name: t.visitsMore })
      .click();
    await expect.poll(() => moreRequested).toBe(true);
    releaseRefresh();
    await expect(rows.first().getByTestId('visit-status')).toHaveText(
      t.visitStatus.cancelled,
    );
    releaseMore();
    await expect.poll(() => moreAnswered).toBe(true);
    await page.waitForTimeout(300);
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId('visits')).not.toContainText('Dr Omar');
    await expect(
      page.getByTestId('visits').getByRole('button', { name: t.visitsMore }),
    ).toBeVisible();
  });
}
