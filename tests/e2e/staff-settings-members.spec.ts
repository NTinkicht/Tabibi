import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
// All staff API calls are mocked with page.route; no server session is needed.
const clinicId = '20000000-0000-4000-8000-000000000001';
const base = `/api/clinics/${clinicId}/memberships`;
const A = '30000000-0000-4000-8000-00000000000a';
const R = '30000000-0000-4000-8000-00000000000b';
const D = '30000000-0000-4000-8000-00000000000c';

async function setup(page: Page, opts: { forbidden?: boolean } = {}) {
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: 'mocked-staff-session',
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let removeStatus = 200;
  await page.route(`**${base}**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'GET') {
      if (opts.forbidden) return route.fulfill({ status: 403, json: {} });
      return route.fulfill({
        json: {
          memberships: [
            {
              userId: D,
              displayName: 'Dr Leila',
              identifier: 'leila@x.dz',
              role: 'doctor',
            },
            {
              userId: A,
              displayName: 'Amel Admin',
              identifier: 'amel@x.dz',
              role: 'clinic_admin',
            },
            {
              userId: R,
              displayName: 'Rym Accueil',
              identifier: 'rym@x.dz',
              role: 'receptionist',
            },
          ],
        },
      });
    }
    calls.push({
      method: req.method(),
      path: path.replace(base, ''),
      body: req.postDataJSON(),
    });
    if (req.method() === 'DELETE' && removeStatus === 409)
      return route.fulfill({ status: 409, json: { error: 'conflict' } });
    return route.fulfill({ json: {} });
  });
  return { calls, setRemoveStatus: (s: number) => (removeStatus = s) };
}

for (const [locale, remove, cancel] of [
  ['fr', 'Retirer l’accès', 'Annuler'],
  ['ar', 'سحب الصلاحية', 'إلغاء'],
] as const) {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    test(`members table ${locale} ${size.width}px`, async ({ page }) => {
      await page.setViewportSize(size);
      const { calls } = await setup(page);
      await page.goto(
        `/operations/${clinicId}/settings/staff?locale=${locale}`,
      );
      const rows = page.locator('tbody tr');
      await expect(rows).toHaveCount(3);
      await expect(page.locator('html')).toHaveAttribute(
        'dir',
        locale === 'ar' ? 'rtl' : 'ltr',
      );
      await expect(rows.first().locator('td[dir="ltr"]')).toBeVisible();

      // Admin <-> reception change goes straight to PATCH.
      const rym = page.getByTestId(`member-${R}`);
      await rym.locator('.tb-segmented button').first().click();
      await expect.poll(() => calls.length).toBe(1);
      expect(calls[0]).toMatchObject({
        method: 'PATCH',
        path: `/${R}`,
        body: { role: 'clinic_admin' },
      });

      // Becoming a doctor sends no request and points to "add a doctor".
      await rym.locator('.tb-segmented button').nth(2).click();
      await expect(
        page.getByRole('link', { name: /Ajouter un médecin|إضافة طبيب/ }),
      ).toBeVisible();
      expect(calls).toHaveLength(1);

      // Leaving the doctor role needs the confirmation; cancel sends nothing.
      const dr = page.getByTestId(`member-${D}`);
      await dr.locator('.tb-segmented button').nth(1).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: cancel }).click();
      await expect(page.getByRole('dialog')).toBeHidden();
      expect(calls).toHaveLength(1);
    });
  }

  test(`removal dialog returns focus and shows the 409 ${locale}`, async ({
    page,
  }) => {
    const { calls, setRemoveStatus } = await setup(page);
    await page.goto(`/operations/${clinicId}/settings/staff?locale=${locale}`);
    setRemoveStatus(409);
    await page
      .getByTestId(`member-${A}`)
      .getByRole('button', { name: remove })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Amel Admin');
    await dialog.getByRole('button', { name: remove }).click();
    await expect(page.locator('main [role="alert"]')).toContainText(
      locale === 'fr' ? 'au moins un administrateur' : 'مسؤول واحد على الأقل',
    );
    expect(calls).toEqual([{ method: 'DELETE', path: `/${A}`, body: null }]);
    await expect(dialog).toBeHidden();
    // The error takes focus; after a successful removal the table does.
    await expect(page.locator('.cs-error')).toBeFocused();
    setRemoveStatus(200);
    await page
      .getByTestId(`member-${R}`)
      .getByRole('button', { name: remove })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: remove })
      .click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.locator('.cs-table-wrap')).toBeFocused();
    expect(calls.at(-1)).toEqual({
      method: 'DELETE',
      path: `/${R}`,
      body: null,
    });
  });
}

test('non-admin sees the admin-only message', async ({ page }) => {
  await setup(page, { forbidden: true });
  await page.goto(`/operations/${clinicId}/settings/staff?locale=fr`);
  await expect(page.locator('main [role="alert"]')).toContainText(
    'Réservé aux administrateurs',
  );
});
