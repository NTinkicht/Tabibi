import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { setStaffPassword } from '@/modules/identity/staff-credentials';

const PASSWORD = 'correct horse battery staple 726';

for (const [locale, dir, title] of [
  ['fr', 'ltr', 'Connexion du personnel'],
  ['ar', 'rtl', 'تسجيل دخول الموظفين'],
] as const) {
  test(`staff sign-in ${locale}: labels, lang/dir, focus on error, keyboard, mobile`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/staff/sign-in?locale=${locale}`);
    const main = page.getByTestId('staff-sign-in');
    await expect(main).toHaveAttribute('lang', locale);
    await expect(main).toHaveAttribute('dir', dir);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    const subject = page.locator('#staff-subject');
    const password = page.locator('#staff-password');
    await expect(subject).toHaveAttribute('autocomplete', 'username');
    await expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await subject.focus();
    await page.keyboard.type(`nobody-${randomUUID()}`);
    await page.keyboard.press('Tab');
    await page.keyboard.type('wrong password value');
    await page.keyboard.press('Enter');
    const summary = page.getByTestId('sign-in-error');
    await expect(summary).toBeFocused();
    expect(page.url()).not.toContain('password');
    expect(page.url()).not.toContain('wrong');
  });
}

test('sign-in returns to a safe path, rejects open redirects, and sign-out works', async ({
  page,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const userId = randomUUID();
  const clinicId = randomUUID();
  const subject = `browser-sign-in-${userId}`;
  try {
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES($1,$2,'Sign In')`,
      [userId, subject],
    );
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES($1,$2,'Sign In Clinic')`,
      [clinicId, `browser-sign-in-${clinicId}`],
    );
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'receptionist')`,
      [clinicId, userId],
    );
    await setStaffPassword(pool, userId, PASSWORD);

    // Unauthenticated visit is redirected with a same-origin return path.
    await page.goto(`/operations/${clinicId}?locale=fr`);
    await expect(page).toHaveURL(/\/staff\/sign-in\?returnTo=/);

    // External return targets are ignored: sign-in lands on the clinic page.
    await page.goto(
      '/staff/sign-in?locale=fr&returnTo=' +
        encodeURIComponent('//evil.example/operations/x'),
    );
    await page.locator('#staff-subject').fill(subject);
    await page.locator('#staff-password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page).toHaveURL(new RegExp(`/operations/${clinicId}`));
    expect(new URL(page.url()).host).toBe('127.0.0.1:3000');

    // A failed logout keeps the user on the page with a retry message.
    await page.route('**/api/staff/session/logout', (route) =>
      route.fulfill({ status: 500, body: '{}' }),
    );
    await page.getByTestId('sign-out').click();
    await expect(page.getByTestId('sign-out-error')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/operations/${clinicId}`));
    await page.unroute('**/api/staff/session/logout');

    // Sign-out revokes the session and returns to the sign-in page.
    await page.getByTestId('sign-out').click();
    await expect(page).toHaveURL(/\/staff\/sign-in/);
    await page.goto(`/operations/${clinicId}`);
    await expect(page).toHaveURL(/\/staff\/sign-in/);
  } finally {
    await pool.query('DELETE FROM clinic_memberships WHERE user_id=$1', [
      userId,
    ]);
    await pool.end();
  }
});
