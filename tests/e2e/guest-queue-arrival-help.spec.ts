import { expect, test } from '@playwright/test';

const PRIVATE_SENTINEL = 'private-guest-bearer-secret';

test('queue arrival help gives French clinic-day guidance', async ({
  page,
}) => {
  await page.goto('/guest/queue-arrival-help');

  const section = page.locator('section[lang="fr"][dir="ltr"]');
  await expect(
    section.getByRole('heading', { name: 'À votre arrivée à la clinique' }),
  ).toBeVisible();
  await expect(section.getByRole('listitem')).toHaveCount(3);
  await expect(section.getByRole('listitem')).toHaveText([
    'Confirmez votre présence lorsque le bouton est disponible.',
    'Actualisez le statut si votre connexion a été interrompue.',
    'Revenez depuis votre lien de réservation si votre accès a expiré.',
  ]);
  await expect(
    section.getByRole('link', { name: 'Comprendre le temps d’attente' }),
  ).toHaveAttribute('href', '/guest/eta-explained?lang=fr');
  await expect(
    section.getByRole('link', { name: 'Revoir les étapes pendant l’attente' }),
  ).toHaveAttribute('href', '/guest/queue-next-steps');
  await expect(page.getByTestId('arrival-emergency-fr')).toContainText(
    'n’attendez pas votre tour dans la file',
  );
  await expect(page.getByTestId('arrival-emergency-ar')).toContainText(
    'ولا تنتظر دورك في قائمة الانتظار',
  );
  expect(page.url()).not.toContain(PRIVATE_SENTINEL);
  await expect(page.locator('body')).not.toContainText(PRIVATE_SENTINEL);
});

test('queue arrival help gives Arabic clinic-day guidance in RTL', async ({
  page,
}) => {
  await page.goto('/guest/queue-arrival-help');

  const section = page.locator('section[lang="ar"][dir="rtl"]');
  await expect(
    section.getByRole('heading', { name: 'عند وصولك إلى العيادة' }),
  ).toBeVisible();
  await expect(section.getByRole('listitem')).toHaveCount(3);
  await expect(section.getByRole('listitem')).toHaveText([
    'أكد حضورك عندما يظهر زر التأكيد.',
    'حدّث الحالة إذا انقطع اتصالك.',
    'عد من رابط الحجز الخاص بك إذا انتهت صلاحية الوصول.',
  ]);
  await expect(
    section.getByRole('link', { name: 'فهم وقت الانتظار' }),
  ).toHaveAttribute('href', '/guest/eta-explained?lang=ar');
  await expect(
    section.getByRole('link', { name: 'مراجعة خطوات الانتظار' }),
  ).toHaveAttribute('href', '/guest/queue-next-steps');
  expect(page.url()).not.toContain(PRIVATE_SENTINEL);
  await expect(page.locator('body')).not.toContainText(PRIVATE_SENTINEL);
});
