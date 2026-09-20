import { expect, test } from '@playwright/test';

test('French ETA guidance distinguishes verified time from live freshness or a promised appointment', async ({
  page,
}) => {
  await page.goto('/guest/eta-explained?lang=fr');

  await expect(
    page.getByRole('heading', { name: 'Comprendre vos estimations Tabibi' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Dernière vérification du statut' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /dernière vérification réussie jusqu’à une nouvelle actualisation confirmée/,
    ),
  ).toBeVisible();
  await expect(page.getByText(/ne garantit pas/)).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Temps d’attente' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Votre vie privée' }),
  ).toBeVisible();
  await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
});

test('Arabic ETA guidance preserves RTL, translates timestamp caveat and changes language without private data', async ({
  page,
}) => {
  await page.goto(
    '/guest/eta-explained?lang=ar&guestBearer=never-expose-bearer',
  );

  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'آخر تحقق من الحالة' }),
  ).toBeVisible();
  await expect(
    page.getByText(/يبقى وقت آخر تحقق ناجح كما هو حتى يكتمل تحديث جديد مؤكّد/),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'وقت الانتظار' }),
  ).toBeVisible();
  await expect(page.locator('main')).not.toContainText('never-expose-bearer');
  await page.getByRole('link', { name: 'Français' }).click();
  await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Dernière vérification du statut' }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has('guestBearer')).toBe(false);
});
