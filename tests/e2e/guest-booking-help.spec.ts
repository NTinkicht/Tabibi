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
    await expect(french.getByRole('listitem').nth(0)).toHaveText(
      'La clinique et le médecin que vous souhaitez consulter.',
    );
    await expect(french.getByRole('listitem').nth(1)).toHaveText(
      'Au moins un moyen de contact : téléphone ou e-mail.',
    );
    await expect(french.getByRole('listitem').nth(2)).toHaveText(
      'Si vous choisissez un contact préféré, renseignez bien ce téléphone ou cet e-mail.',
    );
    await expect(french.locator('p').last()).toHaveText(
      'Cette page d’aide ne demande aucun paiement, mot de passe ou document médical.',
    );

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
    await expect(arabic.getByRole('listitem').nth(0)).toHaveText(
      'العيادة والطبيب اللذان ترغب في اختيارهما.',
    );
    await expect(arabic.getByRole('listitem').nth(1)).toHaveText(
      'وسيلة تواصل واحدة على الأقل: رقم هاتف أو بريد إلكتروني.',
    );
    await expect(arabic.getByRole('listitem').nth(2)).toHaveText(
      'إذا اخترت وسيلة تواصل مفضلة، فتأكد من إدخال رقم الهاتف أو البريد الإلكتروني المطابق لها.',
    );
    await expect(arabic.locator('p').last()).toHaveText(
      'صفحة المساعدة هذه لا تطلب أي دفع أو كلمة مرور أو مستند طبي.',
    );

    expect(page.url()).not.toContain(PRIVATE_SENTINEL);
    expect(await page.locator('body').innerText()).not.toContain(PRIVATE_SENTINEL);
  },
);
