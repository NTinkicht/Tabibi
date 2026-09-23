import { expect, test } from '@playwright/test';

test('queue arrival help gives French clinic-day guidance', async ({ page }) => {
  await page.goto('/guest/queue-arrival-help');

  const section = page.locator('section[lang="fr"][dir="ltr"]');
  await expect(
    section.getByRole('heading', { name: 'À votre arrivée à la clinique' }),
  ).toBeVisible();
  await expect(section.getByText(/Confirmez votre présence/)).toBeVisible();
  await expect(
    section.getByRole('link', { name: 'Comprendre le temps d’attente' }),
  ).toHaveAttribute('href', '/guest/eta-explained?lang=fr');
});

test(
  'queue arrival help gives Arabic clinic-day guidance in RTL',
  async ({ page }) => {
    await page.goto('/guest/queue-arrival-help');

    const section = page.locator('section[lang="ar"][dir="rtl"]');
    await expect(
      section.getByRole('heading', { name: 'عند وصولك إلى العيادة' }),
    ).toBeVisible();
    await expect(section.getByText(/أكد حضورك/)).toBeVisible();
    await expect(
      section.getByRole('link', { name: 'فهم وقت الانتظار' }),
    ).toHaveAttribute('href', '/guest/eta-explained?lang=ar');
  },
);
