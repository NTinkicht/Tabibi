import { expect, test, type Page } from '@playwright/test';

const BOOKING_URL = '**/api/public/bookings';
const STATUS_URL = '**/api/public/bookings/live-queue-status';
const PRIVATE_BEARER = 'failure-focus-private-guest-bearer';

async function mockRetryableBooking(page: Page) {
  let attempts = 0;
  await page.route(BOOKING_URL, (route) => {
    attempts += 1;
    expect(route.request().url()).not.toContain(PRIVATE_BEARER);
    if (attempts === 1) {
      return route.fulfill({ status: 503, body: 'unavailable' });
    }
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        queueLabel: 'G-FOCUS',
        guestBearer: PRIVATE_BEARER,
      }),
    });
  });
  await page.route(STATUS_URL, (route) => {
    expect(route.request().headers()['authorization']).toBe(
      `Bearer ${PRIVATE_BEARER}`,
    );
    expect(route.request().url()).not.toContain(PRIVATE_BEARER);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        bookingState: 'confirmed',
        queueState: 'waiting',
        eta: null,
        activeConsultationRemainingMinutes: null,
      }),
    });
  });
  return () => attempts;
}

for (const locale of ['fr', 'ar'] as const) {
  test(`Guest booking error focus and retry in ${locale}`, async ({ page }) => {
    if (locale === 'ar') {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'language', {
          configurable: true,
          value: 'ar-DZ',
        });
      });
    }
    const bookingAttempts = await mockRetryableBooking(page);
    await page.goto('/guest/live-queue/test-selection-ref');
    const name = locale === 'fr' ? 'Votre nom' : 'اسمك';
    const submit =
      locale === 'fr' ? 'Confirmer la réservation' : 'تأكيد الحجز';
    const error =
      locale === 'fr' ? 'Réservation indisponible' : 'الحجز غير متاح';
    if (locale === 'ar') {
      const rtlForm = page.locator('section[lang="ar"][dir="rtl"]');
      await expect(rtlForm).toBeVisible();
    }
    await page.getByLabel(name).fill('Guest');
    await page.getByRole('button', { name: submit }).click();

    const errorHeading = page.getByRole('heading', {
      level: 2,
      name: error,
    });
    await expect(errorHeading).toBeFocused();
    await expect(errorHeading).toHaveAttribute('tabindex', '-1');
    await expect(page.getByRole('button', { name: submit })).toBeEnabled();
    await expect(page.getByLabel(name)).toHaveValue('Guest');
    expect(bookingAttempts()).toBe(1);

    await page.getByRole('button', { name: submit }).click();
    await expect(page.getByText('G-FOCUS')).toBeVisible();
    await expect(errorHeading).toHaveCount(0);
    expect(bookingAttempts()).toBe(2);
    expect(page.url()).not.toContain(PRIVATE_BEARER);
    expect(await page.locator('body').innerText()).not.toContain(
      PRIVATE_BEARER,
    );
  });
}
