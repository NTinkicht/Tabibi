import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { StaffInviteService } from '@/modules/identity/staff-invites';

// G-18 (#824): the one-time invite link /staff/invite#<token>. The token is
// read from the fragment, dropped from the address bar at once, and never put
// in a URL the server sees.
const PASSWORD = 'correct horse battery staple 824';

test('invite link fr: shows the invite, hides the token, accepts once', async ({
  page,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const clinicId = randomUUID();
  const adminId = randomUUID();
  const email = `browser-invite-${randomUUID()}-with-a-very-long-local-part-for-overflow@x.example`;
  try {
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES($1,$2,'Clinique Invitation')`,
      [clinicId, `browser-invite-${clinicId}`],
    );
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES($1,$2,'Admin')`,
      [adminId, `browser-invite-admin-${adminId}`],
    );
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'clinic_admin')`,
      [clinicId, adminId],
    );
    const { token } = await new StaffInviteService(pool).create(
      { clinicId, actorUserId: adminId },
      { email, role: 'receptionist' },
    );
    const secret = token.split('.')[1]!;

    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/staff/invite?locale=fr#${token}`);
    const main = page.getByTestId('staff-invite');
    await expect(main).toHaveAttribute('lang', 'fr');
    await expect(page.getByTestId('invite-summary')).toContainText(
      'Clinique Invitation',
    );
    await expect(page.getByTestId('invite-summary')).toContainText(
      'réceptionniste',
    );
    expect(page.url()).not.toContain(secret);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    // A long e-mail wraps inside the card instead of overflowing it.
    const card = (await page.locator('.si-card').boundingBox())!;
    const dd = (await page.locator('.si-facts dd').first().boundingBox())!;
    expect(dd.x + dd.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
    expect(dd.x).toBeGreaterThanOrEqual(card.x - 0.5);
    // Foundations card (same as sign-in): brand, 44 px+ fields, 52 px submit.
    await expect(page.locator('.si-card .si-brand')).toHaveText('Tabibi');
    for (const field of ['#invite-name', '#invite-password', '#invite-confirm'])
      expect(
        (await page.locator(field).boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
    expect(
      (await page.locator('.si-submit').boundingBox())!.height,
    ).toBeGreaterThanOrEqual(52);

    await page.locator('#invite-name').fill('Nouvelle Réception');
    await page.locator('#invite-password').fill(PASSWORD);
    await page.locator('#invite-confirm').fill(`${PASSWORD} typo`);
    await page.getByRole('button', { name: 'Rejoindre la clinique' }).click();
    await expect(page.getByTestId('invite-error')).toBeFocused();
    await expect(page.locator('#invite-confirm')).toHaveAttribute(
      'aria-invalid',
      'true',
    );

    await page.locator('#invite-confirm').fill(PASSWORD);
    await page.getByRole('button', { name: 'Rejoindre la clinique' }).click();
    await expect(page.getByTestId('invite-done')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Se connecter' }),
    ).toHaveAttribute('href', '/staff/sign-in?locale=fr');
    expect(page.url()).not.toContain(secret);

    // The same link a second time is no longer valid.
    await page.goto(`/staff/invite?locale=fr#${token}`);
    await expect(page.getByTestId('invite-error')).toBeFocused();
  } finally {
    await pool.end();
  }
});

test('invite link ar without a token: rtl, focused error, no form', async ({
  page,
}) => {
  await page.goto('/staff/invite?locale=ar');
  const main = page.getByTestId('staff-invite');
  await expect(main).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('.si-card .si-brand')).toHaveText('Tabibi');
  await expect(page.getByTestId('invite-error')).toBeFocused();
  await expect(page.locator('#invite-password')).toHaveCount(0);
});
