import { expect, test, type Page } from '@playwright/test';

const BOOKING_URL = '**/api/public/bookings';
const STATUS_URL = '**/api/public/bookings/live-queue-status';
const BEARER = 'details-confirmation-private-bearer.signature';

async function mockBooking(page: Page) {
  await page.route(BOOKING_URL, (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ queueLabel: 'G-805', guestBearer: BEARER }),
    }),
  );
  await page.route(STATUS_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
      }),
    }),
  );
}

async function useArabic(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'ar-DZ',
    });
  });
}

const CASES = [
  {
    name: 'fr',
    arabic: false,
    nameLabel: 'Votre nom',
    hint: /Visible uniquement par la clinique/,
    privacy: 'Comment vos informations sont protégées',
    submit: 'Confirmer la réservation',
    reserved: 'Réservé',
    follow: 'Suivre mon passage',
    radios: { none: 'Aucune', phone: 'Téléphone', email: 'Email' },
    explain: {
      none: /uniquement depuis cette page/,
      phone: /joindre par téléphone/,
      email: /joindre par e-mail/,
    },
    notice: {
      none: /seul accès en ligne/,
      phone: /aucun lien de retour/,
      email: /aucun lien de retour/,
    },
  },
  {
    name: 'ar',
    arabic: true,
    nameLabel: 'اسمك',
    hint: /يراه فقط طاقم العيادة/,
    privacy: 'كيف نحمي معلوماتك',
    submit: 'تأكيد الحجز',
    reserved: 'تم الحجز',
    follow: 'تابع دوري',
    radios: { none: 'بدون', phone: 'الهاتف', email: 'البريد الإلكتروني' },
    explain: {
      none: /من هذه الصفحة فقط/,
      phone: /التواصل معك عبر الهاتف/,
      email: /التواصل معك عبر البريد الإلكتروني/,
    },
    notice: {
      none: /وصولك الوحيد/,
      phone: /ولا يُرسل أي رابط/,
      email: /ولا يُرسل أي رابط/,
    },
  },
] as const;

for (const c of CASES) {
  test(`${c.name}: details explanation, hint and privacy link follow the contact choice`, async ({
    page,
  }) => {
    if (c.arabic) await useArabic(page);
    await page.goto('/guest/live-queue/test-selection-ref');
    await expect(page.getByText(c.hint)).toBeVisible();
    await expect(page.getByRole('link', { name: c.privacy })).toHaveAttribute(
      'href',
      '/guest/privacy-help',
    );
    await expect(page.locator('input[type="tel"]')).toHaveAttribute(
      'dir',
      'ltr',
    );
    const explanation = page.getByTestId('guest-contact-explanation');
    await expect(explanation).toHaveText(c.explain.none);
    await page.getByRole('radio', { name: c.radios.phone }).check();
    await expect(explanation).toHaveText(c.explain.phone);
    await page.getByRole('radio', { name: c.radios.email }).check();
    await expect(explanation).toHaveText(c.explain.email);
  });

  for (const pref of ['none', 'phone', 'email'] as const) {
    test(`${c.name}: confirmation shows the keep-open notice for ${pref}`, async ({
      page,
    }) => {
      if (c.arabic) await useArabic(page);
      await mockBooking(page);
      await page.goto('/guest/live-queue/test-selection-ref');
      await page.getByLabel(c.nameLabel).fill('Guest');
      await page.getByRole('radio', { name: c.radios[pref] }).check();
      await page.locator('input[type="tel"]').fill('0555555555');
      await page.locator('input[type="email"]').fill('guest@example.test');
      await page.getByRole('button', { name: c.submit }).click();
      await expect(page.getByText('G-805')).toBeVisible();
      await expect(page.getByText(c.reserved, { exact: true })).toBeVisible();
      await expect(page.getByTestId('guest-keep-open-notice')).toContainText(
        c.notice[pref],
      );
      await expect(page.getByRole('link', { name: c.follow })).toHaveAttribute(
        'href',
        '#guest-visit-status',
      );
      expect(page.url()).not.toContain(BEARER);
      expect(await page.locator('body').innerText()).not.toContain(BEARER);
    });
  }
}

test('terminal status hides the reserved chip and keep-open notice', async ({
  page,
}) => {
  await page.route(BOOKING_URL, (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ queueLabel: 'G-806', guestBearer: BEARER }),
    }),
  );
  await page.route(STATUS_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'cancelled',
        queueState: 'waiting',
      }),
    }),
  );
  await page.goto('/guest/live-queue/test-selection-ref');
  await page.getByLabel('Votre nom').fill('Guest');
  await page.locator('input[type="tel"]').fill('0555555555');
  await page.getByRole('button', { name: 'Confirmer la réservation' }).click();
  await expect(page.getByText('G-806')).toBeVisible();
  await expect(page.getByText('annulée').first()).toBeVisible();
  await expect(page.getByText('Réservé', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('guest-keep-open-notice')).toHaveCount(0);
});
