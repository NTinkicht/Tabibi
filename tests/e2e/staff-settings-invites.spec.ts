import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
// All staff API calls are mocked with page.route; no server session is needed.
const clinicId = '20000000-0000-4000-8000-000000000001';
const api = `/api/clinics/${clinicId}`;
const TOKEN = 'tok_one_time_secret_0123456789';
const LIVE = '40000000-0000-4000-8000-00000000000a';
const OLD = '40000000-0000-4000-8000-00000000000b';

async function setup(page: Page) {
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
  let createStatus = 201;
  let revokeStatus = 200;
  const invites = [
    {
      inviteId: LIVE,
      email: 'nouveau@x.dz',
      role: 'receptionist',
      status: 'pending',
      createdAt: '2026-11-10T09:00:00.000Z',
      expiresAt: '2026-11-17T09:00:00.000Z',
    },
    {
      inviteId: OLD,
      email: 'ancien@x.dz',
      role: 'doctor',
      status: 'expired',
      createdAt: '2026-10-01T09:00:00.000Z',
      expiresAt: '2026-10-08T09:00:00.000Z',
    },
  ];
  await page.route(`**${api}/memberships`, (route) =>
    route.fulfill({
      json: {
        memberships: [
          {
            userId: '30000000-0000-4000-8000-00000000000a',
            displayName: 'Amel Admin',
            identifier: 'amel@x.dz',
            role: 'clinic_admin',
          },
        ],
      },
    }),
  );
  await page.route(`**${api}/staff-invites**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(
      `${api}/staff-invites`,
      '',
    );
    if (req.method() === 'GET') return route.fulfill({ json: { invites } });
    calls.push({ method: req.method(), path, body: req.postDataJSON() });
    if (req.method() === 'POST') {
      if (createStatus === 409)
        return route.fulfill({ status: 409, json: { error: 'conflict' } });
      if (createStatus === 400)
        return route.fulfill({
          status: 400,
          json: { error: 'invalid_request' },
        });
      return route.fulfill({
        status: 201,
        json: {
          invite: {
            inviteId: LIVE,
            token: TOKEN,
            expiresAt: '2026-11-21T09:00:00.000Z',
          },
        },
      });
    }
    if (revokeStatus === 404)
      return route.fulfill({ status: 404, json: { error: 'not_found' } });
    return route.fulfill({ json: { revoked: { inviteId: LIVE } } });
  });
  return {
    calls,
    setCreate: (s: number) => (createStatus = s),
    setRevoke: (s: number) => (revokeStatus = s),
  };
}

for (const [locale, create, revoke, duplicate, expired] of [
  [
    'fr',
    'Créer le lien d’invitation',
    'Révoquer',
    'déjà en attente',
    'Expirée',
  ],
  ['ar', 'إنشاء رابط الدعوة', 'إلغاء الدعوة', 'قيد الانتظار', 'منتهية'],
] as const) {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    test(`invite link shown once, duplicate 409, revoke ${locale} ${size.width}px`, async ({
      page,
      context,
    }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.setViewportSize(size);
      const { calls, setCreate, setRevoke } = await setup(page);
      await page.goto(
        `/operations/${clinicId}/settings/staff?locale=${locale}`,
      );
      await expect(page.getByTestId(`invite-${OLD}`)).toContainText(expired);
      await expect(page.getByTestId(`invite-${LIVE}`)).not.toContainText(
        expired,
      );

      // Positive control: the link is created, shown once and copyable.
      await page.locator('#cs-invite-email').fill('  nina@x.dz ');
      await page.getByRole('button', { name: create }).click();
      const link = page.locator('#cs-invite-link');
      await expect(link).toHaveValue(
        /^https?:\/\/[^/]+\/staff\/invite#tok_one_time_secret_0123456789$/,
      );
      expect(calls[0]).toEqual({
        method: 'POST',
        path: '',
        body: { email: 'nina@x.dz', role: 'receptionist' },
      });
      // The token is not in the page URL or storage.
      expect(page.url()).not.toContain(TOKEN);
      expect(
        await page.evaluate(
          (tok) =>
            JSON.stringify(localStorage).includes(tok) ||
            JSON.stringify(sessionStorage).includes(tok),
          TOKEN,
        ),
      ).toBe(false);
      await page
        .getByTestId('invite-link-panel')
        .getByRole('button')
        .first()
        .click();
      await expect(page.locator('main [role="status"]')).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
        /\/staff\/invite#tok_one_time_secret_0123456789$/,
      );

      // A reload never shows the link again.
      await page.reload();
      await expect(page.locator('#cs-invite-link')).toHaveCount(0);

      // Duplicate address: the 409 message, and no link.
      setCreate(409);
      await page.locator('#cs-invite-email').fill('nouveau@x.dz');
      await page.getByRole('button', { name: create }).click();
      await expect(page.locator('#cs-invite-error')).toContainText(duplicate);
      await expect(page.locator('#cs-invite-link')).toHaveCount(0);

      // Revoke calls DELETE; a 404 still refreshes the list without a crash.
      await page
        .getByTestId(`invite-${LIVE}`)
        .getByRole('button', { name: revoke })
        .click();
      await expect.poll(() => calls.at(-1)?.method).toBe('DELETE');
      expect(calls.at(-1)?.path).toBe(`/${LIVE}`);
      setRevoke(404);
      await page
        .getByTestId(`invite-${OLD}`)
        .getByRole('button', { name: revoke })
        .click();
      await expect.poll(() => calls.length).toBeGreaterThanOrEqual(4);
      await expect(page.getByTestId(`invite-${OLD}`)).toBeVisible();
    });
  }
}

test('invalid e-mail (400) shows the field error and no link', async ({
  page,
}) => {
  const { calls, setCreate } = await setup(page);
  await page.goto(`/operations/${clinicId}/settings/staff?locale=fr`);
  setCreate(400);
  await page.locator('#cs-invite-email').fill('pas-un-email');
  await page
    .getByRole('button', { name: 'Créer le lien d’invitation' })
    .click();
  await expect(page.locator('#cs-invite-error')).toContainText(
    'adresse e-mail valide',
  );
  await expect(page.locator('#cs-invite-email')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(page.locator('#cs-invite-link')).toHaveCount(0);
  expect(calls).toHaveLength(1);
  // Positive control: a valid retry clears the error and shows the link.
  setCreate(201);
  await page
    .getByRole('button', { name: 'Créer le lien d’invitation' })
    .click();
  await expect(page.locator('#cs-invite-error')).toHaveCount(0);
  await expect(page.locator('#cs-invite-link')).toBeVisible();
});
