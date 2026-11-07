import { expect, test } from '@playwright/test';

// TAB-UI-01b: client-side language switches update <html lang/dir> and font.
test('sign-in language toggle updates html lang, dir and font', async ({
  page,
}) => {
  await page.goto('/staff/sign-in?locale=ar');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', 'ar');
  await page.getByRole('button', { name: 'Français' }).click();
  await expect(html).toHaveAttribute('lang', 'fr');
  await expect(html).toHaveAttribute('dir', 'ltr');
  expect(
    await page.evaluate(() => getComputedStyle(document.body).fontFamily),
  ).toMatch(/^"?IBM Plex Sans"?,/);
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(html).toHaveAttribute('lang', 'ar');
  await expect(html).toHaveAttribute('dir', 'rtl');
});

test('landing page with Arabic browser sets html rtl', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'ar-DZ' });
  const page = await context.newPage();
  await page.route('**/api/public/discovery', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ page: 1, hasMore: false, clinics: [] }),
    }),
  );
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await context.close();
});
