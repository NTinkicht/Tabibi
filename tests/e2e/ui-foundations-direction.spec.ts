import { expect, test } from '@playwright/test';

// TAB-UI-01: root html lang/dir follow the active locale on a public page.
const url = '/staff/sign-in';

for (const [locale, dir] of [
  ['ar', 'rtl'],
  ['fr', 'ltr'],
] as const) {
  test(`html carries lang=${locale} dir=${dir}`, async ({ page }) => {
    await page.goto(`${url}?locale=${locale}`);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', locale);
    await expect(html).toHaveAttribute('dir', dir);
    const family = await page.evaluate(
      () => getComputedStyle(document.body).fontFamily,
    );
    expect(
      family.startsWith(
        locale === 'ar' ? '"IBM Plex Sans Arabic"' : '"IBM Plex Sans"',
      ),
    ).toBe(true);
  });
}
