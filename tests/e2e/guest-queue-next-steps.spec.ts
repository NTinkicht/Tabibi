import { expect, test } from '@playwright/test';

const PRIVATE_SENTINEL = 'private-guest-bearer-secret';

test('queue next steps are bilingual, RTL-aware and link to safe guidance', async ({
  page,
}) => {
  await page.goto('/guest/queue-next-steps');
  const french = page.locator('section[lang="fr"]');
  const arabic = page.locator('section[lang="ar"]');
  await expect(
    french.getByRole('heading', { name: 'Que faire pendant l’attente' }),
  ).toBeVisible();
  await expect(arabic).toHaveAttribute('dir', 'rtl');
  await expect(
    arabic.getByRole('heading', { name: 'ماذا تفعل أثناء الانتظار' }),
  ).toBeVisible();
  await expect(french.getByRole('listitem')).toHaveCount(3);
  await expect(arabic.getByRole('listitem')).toHaveCount(3);
  await expect(
    french.getByRole('link', { name: 'Voir les consignes d’arrivée' }),
  ).toHaveAttribute('href', '/guest/queue-arrival-help');
  await expect(
    arabic.getByRole('link', { name: 'عرض تعليمات الوصول' }),
  ).toHaveAttribute('href', '/guest/queue-arrival-help');
  await expect(
    french.getByRole('link', {
      name: 'Comprendre l’estimation du temps d’attente',
    }),
  ).toHaveAttribute('href', '/guest/eta-explained?lang=fr');
  await expect(
    arabic.getByRole('link', { name: 'فهم تقدير وقت الانتظار' }),
  ).toHaveAttribute('href', '/guest/eta-explained?lang=ar');
  await expect(
    french.getByRole('link', { name: 'Comprendre les notifications de tour' }),
  ).toHaveAttribute('href', '/guest/notification-help');
  await expect(
    arabic.getByRole('link', { name: 'فهم إشعارات حلول الدور' }),
  ).toHaveAttribute('href', '/guest/notification-help');
  expect(page.url()).not.toContain(PRIVATE_SENTINEL);
  expect(await page.locator('body').innerText()).not.toContain(
    PRIVATE_SENTINEL,
  );
});
