import { expect, test } from '@playwright/test';

test('booking contact help explains the French contact contract', async ({
  page,
}) => {
  await page.goto('/guest/booking-contact-help');

  const section = page.locator('section[lang="fr"][dir="ltr"]');
  await expect(
    section.getByRole('heading', {
      name: 'Coordonnées pour votre réservation',
    }),
  ).toBeVisible();
  await expect(section.getByText(/au moins un moyen de contact/)).toBeVisible();
  await expect(section.getByRole('listitem').nth(2)).toContainText(
    'Le moyen choisi doit être renseigné avant la confirmation.',
  );
  await expect(
    section.getByRole('link', { name: 'Revenir à la préparation' }),
  ).toHaveAttribute('href', '/guest/booking-help');
});

test(
  'booking contact help explains the Arabic contact contract in RTL',
  async ({ page }) => {
    await page.goto('/guest/booking-contact-help');

    const section = page.locator('section[lang="ar"][dir="rtl"]');
    await expect(
      section.getByRole('heading', { name: 'بيانات التواصل للحجز' }),
    ).toBeVisible();
    await expect(
      section.getByText(/وسيلة تواصل واحدة على الأقل/),
    ).toBeVisible();
    await expect(section.getByRole('listitem').nth(2)).toContainText(
      'يجب إدخال وسيلة التواصل التي اخترتها قبل تأكيد الحجز.',
    );
    await expect(
      section.getByRole('link', { name: 'العودة إلى التحضير' }),
    ).toHaveAttribute('href', '/guest/booking-help');
  },
);
