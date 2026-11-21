import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { accountStrings } from '@/app/account/strings';

const PASSWORD = 'correct horse battery staple 959';

async function sessionStatus(page: Page): Promise<number> {
  return page.evaluate(
    async () => (await fetch('/api/patient/session')).status,
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
