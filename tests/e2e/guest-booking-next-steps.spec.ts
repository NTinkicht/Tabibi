import { expect, test } from '@playwright/test';

const PRIVATE_SENTINEL = 'private-guest-bearer-secret';

test('guest booking next steps are clear in French without private data', async ({
  page,
}) => {
  await page.goto('/guest/booking-next-steps');

  const french = page.locator('section[lang="fr"][dir="ltr"]');
  await expect(
    french.getByRole('heading', { name: 'Continuer votre réservation' }),
  ).toBeVisible();
  await expect(french.getByRole('listitem')).toHaveCount(5);
  await expect(french.getByRole('listitem').nth(3)).toHaveText(
    'Renseignez le moyen de contact choisi comme préféré avant de confirmer.',
  );
  await expect(french.getByRole('listitem').nth(0)).toHaveText(
    'Retournez au parcours de réservation invité.',
  );
  await expect(french.getByRole('listitem').nth(4)).toHaveText(
    'Vérifiez vos informations, puis envoyez la demande une seule fois.',
  );
  await expect(french.locator('p').last()).toContainText(
    'aucun paiement, mot de passe, document médical ou code d’accès invité',
  );
  await expect(page.getByTestId('booking-emergency-fr')).toContainText(
    'services d’urgence locaux',
  );
  await expect(page.getByTestId('booking-emergency-fr')).toContainText(
    'n’attendez pas la confirmation de réservation',
  );
  await expect(
    french.getByRole('link', { name: 'Revoir la préparation' }),
  ).toHaveAttribute('href', '/guest/booking-help');
  await expect(
    french.getByRole('link', { name: 'Protéger vos informations' }),
  ).toHaveAttribute('href', '/guest/privacy-help');
  await expect(
    french.getByRole('link', {
      name: 'Comprendre les notifications de réservation',
    }),
  ).toHaveAttribute('href', '/guest/notification-help');
  await expect(
    french.getByRole('link', { name: 'Préparer votre arrivée à la clinique' }),
  ).toHaveAttribute('href', '/guest/queue-arrival-help');
  expect(page.url()).not.toContain(PRIVATE_SENTINEL);
  expect(await page.locator('body').innerText()).not.toContain(
    PRIVATE_SENTINEL,
  );
});

test('guest booking next steps are equivalent in Arabic RTL', async ({
  page,
}) => {
  await page.goto('/guest/booking-next-steps');

  const arabic = page.locator('section[lang="ar"][dir="rtl"]');
  await expect(
    arabic.getByRole('heading', { name: 'تابع حجز موعدك' }),
  ).toBeVisible();
  await expect(arabic.getByRole('listitem')).toHaveCount(5);
  await expect(arabic.getByRole('listitem').nth(3)).toHaveText(
    'أدخل وسيلة التواصل المفضلة التي اخترتها قبل التأكيد.',
  );
  await expect(arabic.getByRole('listitem').nth(0)).toHaveText(
    'ارجع إلى مسار حجز الموعد للزائر.',
  );
  await expect(arabic.getByRole('listitem').nth(4)).toHaveText(
    'راجع معلوماتك ثم أرسل الطلب مرة واحدة فقط.',
  );
  await expect(arabic.locator('p').last()).toContainText(
    'لا يطلب أي دفع أو كلمة مرور أو مستند طبي أو رمز دخول للزائر',
  );
  await expect(page.getByTestId('booking-emergency-ar')).toContainText(
    'خدمات الطوارئ المحلية',
  );
  await expect(page.getByTestId('booking-emergency-ar')).toContainText(
    'ولا تنتظر تأكيد الحجز',
  );
  await expect(
    arabic.getByRole('link', { name: 'مراجعة التحضير' }),
  ).toHaveAttribute('href', '/guest/booking-help');
  await expect(
    arabic.getByRole('link', { name: 'حماية معلوماتك' }),
  ).toHaveAttribute('href', '/guest/privacy-help');
  await expect(
    arabic.getByRole('link', { name: 'فهم إشعارات الحجز' }),
  ).toHaveAttribute('href', '/guest/notification-help');
  await expect(
    arabic.getByRole('link', { name: 'استعد للوصول إلى العيادة' }),
  ).toHaveAttribute('href', '/guest/queue-arrival-help');
  expect(page.url()).not.toContain(PRIVATE_SENTINEL);
  expect(await page.locator('body').innerText()).not.toContain(
    PRIVATE_SENTINEL,
  );
});
