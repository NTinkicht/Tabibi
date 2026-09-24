import { expect, test } from '@playwright/test';

test('guest privacy help provides equivalent French and Arabic guidance', async ({
  page,
}) => {
  await page.goto('/guest/privacy-help');
  const french = page.locator('section[lang="fr"]');
  const arabic = page.locator('section[lang="ar"]');
  await expect(
    french.getByRole('heading', {
      name: 'Protéger vos informations pendant le parcours invité',
    }),
  ).toBeVisible();
  await expect(arabic).toHaveAttribute('dir', 'rtl');
  await expect(
    arabic.getByRole('heading', {
      name: 'حماية معلوماتك أثناء استخدام مسار الضيف',
    }),
  ).toBeVisible();
  await expect(french.getByRole('listitem')).toHaveCount(3);
  await expect(arabic.getByRole('listitem')).toHaveCount(3);
  await expect(french.getByRole('link')).toHaveAttribute(
    'href',
    '/guest/booking-contact-help',
  );
  await expect(arabic.getByRole('link')).toHaveAttribute(
    'href',
    '/guest/booking-contact-help',
  );
});
