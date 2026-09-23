import { expect, test, type Page } from '@playwright/test';

const BOOKING_URL = '**/api/public/bookings';
const STATUS_URL = '**/api/public/bookings/live-queue-status';
const PRIVATE_BEARER = 'contact-validation-private-bearer.signature';

async function captureBooking(page: Page) {
  let submitted = 0;
  let preference: string | null = null;
  await page.route(BOOKING_URL, (route) => {
    submitted += 1;
    const request = route.request();
    expect(request.url()).not.toContain(PRIVATE_BEARER);
    const body = request.postDataJSON() as {
      contactPreference: string;
      contactPhone: string | null;
      contactEmail: string | null;
    };
    preference = body.contactPreference;
    if (body.contactPreference === 'phone') {
      expect(body.contactPhone).toBeTruthy();
    }
    if (body.contactPreference === 'email') {
      expect(body.contactEmail).toBeTruthy();
    }
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        queueLabel: 'G-CONTACT',
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
      }),
    }),
  );
  return {
    count: () => submitted,
    preference: () => preference,
  };
}

test(
  'French guest form avoids a futile POST when the chosen email contact is missing',
  async ({ page }) => {
    const captured = await captureBooking(page);
    await page.goto('/guest/live-queue/test-selection-ref');
    const phone = page.locator('input[type="tel"]');
    const email = page.locator('input[type="email"]');
    await expect(phone).toHaveAttribute(
      'aria-describedby',
      'guest-contact-requirement',
    );
    await expect(email).toHaveAttribute(
      'aria-describedby',
      'guest-contact-requirement',
    );
    await expect(page.getByText(/Indiquez au moins un contact/)).toBeVisible();
    await page.getByLabel('Votre nom').fill('Guest');
    const submit = page.getByRole('button', {
      name: 'Confirmer la réservation',
    });
    await submit.click();
    expect(captured.count()).toBe(0);

    await page.getByRole('radio', { name: 'Email' }).check();
    await phone.fill('   ');
    await submit.click();
    expect(captured.count()).toBe(0);
    await email.fill('guest@example.test');
    await expect(phone).toHaveJSProperty('validationMessage', '');

    await phone.fill(' 1 ');
    await expect(phone).not.toHaveJSProperty('validationMessage', '');
    await submit.click();
    expect(captured.count()).toBe(0);

    await phone.fill('   ');
    await expect(phone).toHaveJSProperty('validationMessage', '');
    await submit.click();
    await expect.poll(captured.count).toBe(1);
    expect(captured.preference()).toBe('email');
    expect(page.url()).not.toContain(PRIVATE_BEARER);
  },
);

test(
  'Arabic RTL guest form requires a phone when phone is preferred',
  async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'language', {
        configurable: true,
        value: 'ar-DZ',
      });
    });
    const captured = await captureBooking(page);
    await page.goto('/guest/live-queue/test-selection-ref');
    await expect(
      page.locator('section[lang="ar"][dir="rtl"]'),
    ).toBeVisible();
    await expect(
      page.getByText(/أدخل وسيلة اتصال واحدة على الأقل/),
    ).toBeVisible();
    await page.getByLabel('اسمك').fill('Guest');
    await page.getByRole('radio', { name: 'الهاتف' }).check();
    const phone = page.locator('input[type="tel"]');
    const email = page.locator('input[type="email"]');
    await email.fill('guest@example.test');
    const submit = page.getByRole('button', { name: 'تأكيد الحجز' });
    await submit.click();
    expect(captured.count()).toBe(0);

    await phone.fill('   ');
    await expect(phone).not.toHaveJSProperty('validationMessage', '');
    await submit.click();
    expect(captured.count()).toBe(0);

    await phone.fill('0555555555');
    await submit.click();
    await expect.poll(captured.count).toBe(1);
    expect(captured.preference()).toBe('phone');
    expect(page.url()).not.toContain(PRIVATE_BEARER);
    expect(await page.locator('body').innerText()).not.toContain(PRIVATE_BEARER);
  },
);
