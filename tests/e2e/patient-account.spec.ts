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
      const issued = await issuePatientPasswordReset(pool, email);
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
