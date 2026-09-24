import { expect, test, type Page } from '@playwright/test';

const BOOKING_URL = '**/api/public/bookings';
const STATUS_URL = '**/api/public/bookings/live-queue-status';
const PRIVATE_BEARER = 'preferred-language-private-bearer.signature';

async function captureBookingLocale(page: Page) {
  let selectedLocale: string | null = null;
  await page.route(BOOKING_URL, (route) => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    expect(request.url()).not.toContain(PRIVATE_BEARER);
    const payload = request.postDataJSON() as { preferredLocale: string };
    selectedLocale = payload.preferredLocale;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        queueLabel: 'G-LANG',
        guestBearer: PRIVATE_BEARER,
      }),
    });
  });
  await page.route(STATUS_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
        eta: null,
        activeConsultationRemainingMinutes: null,
      }),
    }),
  );
  return () => selectedLocale;
}

test('French guest booking clearly labels preferred language and submits selected Arabic', async ({
  page,
}) => {
  const getSelectedLocale = await captureBookingLocale(page);
  await page.goto('/guest/live-queue/test-selection-ref');
  const preferredLanguage = page.getByRole('group', {
    name: 'Langue préférée',
  });
  await expect(preferredLanguage).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Préférence de contact' }),
  ).toBeVisible();
  await preferredLanguage.getByRole('radio', { name: 'العربية' }).check();
  await expect(
    preferredLanguage.getByRole('radio', { name: 'العربية' }),
  ).toBeChecked();
  await page.getByLabel('Votre nom').fill('Guest');
  await page.locator('input[type="email"]').fill('guest@example.test');
  await page.getByRole('button', { name: 'Confirmer la réservation' }).click();
  await expect.poll(getSelectedLocale).toBe('ar');
  expect(page.url()).not.toContain(PRIVATE_BEARER);
});

test('Arabic RTL guest booking labels language independently from contact and submits French', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'ar-DZ',
    });
  });
  const getSelectedLocale = await captureBookingLocale(page);
  await page.goto('/guest/live-queue/test-selection-ref');
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
  const preferredLanguage = page.getByRole('group', {
    name: 'اللغة المفضلة',
  });
  await expect(preferredLanguage).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'تفضيل الاتصال' }),
  ).toBeVisible();
  await preferredLanguage.getByRole('radio', { name: 'Français' }).check();
  await expect(
    preferredLanguage.getByRole('radio', { name: 'Français' }),
  ).toBeChecked();
  await page.getByLabel('اسمك').fill('Guest');
  await page.locator('input[type="email"]').fill('guest@example.test');
  await page.getByRole('button', { name: 'تأكيد الحجز' }).click();
  await expect.poll(getSelectedLocale).toBe('fr');
  expect(page.url()).not.toContain(PRIVATE_BEARER);
});

test('French browser defaults the booking preference to French without manual selection', async ({
  page,
}) => {
  const getSelectedLocale = await captureBookingLocale(page);
  await page.goto('/guest/live-queue/test-selection-ref');
  const preferredLanguage = page.getByRole('group', {
    name: 'Langue préférée',
  });
  await expect(
    preferredLanguage.getByRole('radio', { name: 'Français' }),
  ).toBeChecked();
  await page.getByLabel('Votre nom').fill('Guest');
  await page.locator('input[type="email"]').fill('guest@example.test');
  await page.getByRole('button', { name: 'Confirmer la réservation' }).click();
  await expect.poll(getSelectedLocale).toBe('fr');
  expect(page.url()).not.toContain(PRIVATE_BEARER);
});

test('Arabic browser defaults preferred booking language to Arabic after hydration', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'ar-DZ',
    });
  });
  const getSelectedLocale = await captureBookingLocale(page);
  await page.goto('/guest/live-queue/test-selection-ref');
  await expect(page.locator('section[lang="ar"][dir="rtl"]')).toBeVisible();
  const preferredLanguage = page.getByRole('group', {
    name: 'اللغة المفضلة',
  });
  await expect(
    preferredLanguage.getByRole('radio', { name: 'العربية' }),
  ).toBeChecked();
  await page.getByLabel('اسمك').fill('Guest');
  await page.locator('input[type="email"]').fill('guest@example.test');
  await page.getByRole('button', { name: 'تأكيد الحجز' }).click();
  await expect.poll(getSelectedLocale).toBe('ar');
  expect(page.url()).not.toContain(PRIVATE_BEARER);
});
