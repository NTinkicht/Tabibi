import { expect, test } from '@playwright/test';

const PRIVATE_SENTINEL = 'private-guest-bearer-secret';

test(
  'guest booking help exposes French preparation guidance without private data',
  async ({ page }) => {
    await page.goto('/guest/booking-help');

    const french = page.locator('section[lang="fr"][dir="ltr"]');
    await expect(
      french.getByRole('heading', { name: 'Préparer votre réservation' }),
    ).toBeVisible();
    await expect(french.getByRole('listitem')).toHaveCount(3);
    await expect(french).toContainText('Au moins un moyen de contact');
    await expect(french).toContainText('ne demande aucun paiement');

    expect(page.url()).not.toContain(PRIVATE_SENTINEL);
    expect(await page.locator('body').innerText()).not.toContain(
      PRIVATE_SENTINEL,
    );
  },
);

test(
  'guest booking help exposes equivalent Arabic RTL preparation guidance',
  async ({ page }) => {
    await page.goto('/guest/booking-help');

    const arabic = page.locator('section[lang="ar"][dir="rtl"]');
    await expect(
      arabic.getByRole('heading', { name: 'استعد لحجز موعدك' }),
    ).toBeVisible();
    await expect(arabic.getByRole('listitem')).toHaveCount(3);
    await expect(arabic).toContainText('وسيلة تواصل واحدة على الأقل');
    await expect(arabic).toContainText('لا تطلب أي دفع');

    expect(page.url()).not.toContain(PRIVATE_SENTINEL);
    expect(await page.locator('body').innerText()).not.toContain(PRIVATE_SENTINEL);
  },
);
