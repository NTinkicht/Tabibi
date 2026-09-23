import { expect, test } from '@playwright/test';

test('Arabic regional ETA links render RTL', async ({ page }) => {
  for (const lang of ['ar', 'AR-DZ', 'ar_ae']) {
    await page.goto(`/guest/eta-explained?lang=${lang}`);
    await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 1, name: 'فهم تقديرات طبيبي' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'آخر تحقق من الحالة' }),
    ).toBeVisible();
  }
});

test('Unknown ETA locale falls back to French', async ({ page }) => {
  for (const lang of ['argentina', 'en-US', 'fr']) {
    await page.goto(`/guest/eta-explained?lang=${lang}`);
    await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Comprendre vos estimations Tabibi',
      }),
    ).toBeVisible();
  }
});

test('ETA explainer does not echo private search params', async ({ page }) => {
  const sentinel = 'private-guest-bearer-sentinel';
  await page.goto(`/guest/eta-explained?lang=AR-DZ&unused=${sentinel}`);
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  expect(await page.locator('main').innerText()).not.toContain(sentinel);
  await page.getByRole('link', { name: 'Français' }).click();
  await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
  expect(page.url()).not.toContain(sentinel);
});

test('ETA active language link is announced', async ({ page }) => {
  const french = page.getByRole('link', { name: 'Français' });
  const arabic = page.getByRole('link', { name: 'العربية' });
  await page.goto('/guest/eta-explained?lang=fr');
  await expect(french).toHaveAttribute('aria-current', 'page');
  await expect(arabic).not.toHaveAttribute('aria-current');

  await arabic.click();
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(arabic).toHaveAttribute('aria-current', 'page');
  await expect(french).not.toHaveAttribute('aria-current');

  await french.click();
  await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
  await expect(french).toHaveAttribute('aria-current', 'page');
  await expect(arabic).not.toHaveAttribute('aria-current');
});

test('Regional Arabic deep links mark Arabic as current', async ({ page }) => {
  await page.goto('/guest/eta-explained?lang=AR-DZ');
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  const arabic = page.getByRole('link', { name: 'العربية' });
  const french = page.getByRole('link', { name: 'Français' });
  await expect(arabic).toHaveAttribute('aria-current', 'page');
  await expect(french).not.toHaveAttribute('aria-current');
});

test('French ETA quick nav jumps to recovery', async ({ page }) => {
  const secret = 'private-guest-token-never-in-explainer';
  await page.goto('/guest/eta-explained?lang=fr');
  const quickNav = page.getByRole('navigation', { name: 'Sur cette page' });
  await expect(quickNav.getByRole('link')).toHaveCount(5);
  const recoveryLink = quickNav.getByRole('link', {
    name: 'Si le statut n’est plus à jour',
  });
  await recoveryLink.focus();
  await recoveryLink.press('Enter');
  const recoveryHeading = page.getByRole('heading', {
    name: 'Si le statut n’est plus à jour',
  });
  await expect(recoveryHeading).toHaveAttribute('id', 'recovery-heading');
  await expect(recoveryHeading).toHaveAttribute('tabindex', '-1');
  await expect(recoveryHeading).toBeFocused();
  await expect(page).toHaveURL(/#recovery-heading$/);
  expect(page.url()).not.toContain(secret);
  expect(await page.locator('main').innerText()).not.toContain(secret);
});

test('Arabic RTL ETA explainer jumps to last verified explanation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/guest/eta-explained?lang=AR-DZ');
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  const quickNav = page.getByRole('navigation', { name: 'في هذه الصفحة' });
  await expect(quickNav.getByRole('link')).toHaveCount(5);
  const verificationLink = quickNav.getByRole('link', {
    name: 'آخر تحقق من الحالة',
  });
  await verificationLink.focus();
  await verificationLink.press('Enter');
  const verificationHeading = page.getByRole('heading', {
    name: 'آخر تحقق من الحالة',
  });
  await expect(verificationHeading).toHaveAttribute(
    'id',
    'verification-heading',
  );
  await expect(verificationHeading).toHaveAttribute('tabindex', '-1');
  await expect(verificationHeading).toBeFocused();
  await expect(page).toHaveURL(/#verification-heading$/);
  await expect(page.getByRole('link', { name: 'العربية' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(page.url()).not.toContain('private-guest-token');
});

test('All five bilingual ETA anchor targets support programmatic focus without new tab stops', async ({
  page,
}) => {
  for (const lang of ['fr', 'AR-DZ']) {
    await page.goto(`/guest/eta-explained?lang=${lang}`);
    for (const id of [
      'queue-estimate-heading',
      'consultation-estimate-heading',
      'verification-heading',
      'recovery-heading',
      'privacy-heading',
    ]) {
      const heading = page.locator(`h2#${id}`);
      await expect(heading).toHaveAttribute('tabindex', '-1');
      await heading.focus();
      await expect(heading).toBeFocused();
    }
    expect(page.url()).not.toContain('private-guest-bearer');
  }
});

test('French to Arabic switch retains current ETA recovery section without private params', async ({
  page,
}) => {
  const privateValue = 'private-section-bearer-do-not-forward';
  await page.goto(`/guest/eta-explained?lang=fr&opaque=${privateValue}`);
  const quickNav = page.getByRole('navigation', { name: 'Sur cette page' });
  const recoveryLink = quickNav.getByRole('link', {
    name: 'Si le statut n’est plus à jour',
  });
  await recoveryLink.focus();
  await recoveryLink.press('Enter');
  await expect(page).toHaveURL(/#recovery-heading$/);
  const arabic = page.getByRole('link', { name: 'العربية' });
  await expect(arabic).toHaveAttribute('href', '?lang=ar#recovery-heading');
  await arabic.click();

  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(page).toHaveURL(
    /\/guest\/eta-explained\?lang=ar#recovery-heading$/,
  );
  await expect(page.locator('h2#recovery-heading')).toHaveAttribute(
    'tabindex',
    '-1',
  );
  await expect(arabic).toHaveAttribute('aria-current', 'page');
  expect(page.url()).not.toContain(privateValue);
  expect(await page.locator('main').innerText()).not.toContain(privateValue);
});

test('Arabic regional ETA language switch discards unknown and private fragments', async ({
  page,
}) => {
  const privateValue = 'private-guest-fragment-never-forward';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `/guest/eta-explained?lang=AR-DZ&unused=${privateValue}#${privateValue}`,
  );
  await expect(page.locator('main[lang="ar"][dir="rtl"]')).toBeVisible();
  const french = page.getByRole('link', { name: 'Français' });
  await expect(french).toHaveAttribute('href', '?lang=fr');
  await french.click();
  await expect(page.locator('main[lang="fr"][dir="ltr"]')).toBeVisible();
  await expect(page).toHaveURL(/\/guest\/eta-explained\?lang=fr$/);
  expect(page.url()).not.toContain(privateValue);
  await page
    .getByRole('navigation', { name: 'Sur cette page' })
    .getByRole('link', { name: 'Dernière vérification du statut' })
    .click();
  await expect(page.getByRole('link', { name: 'العربية' })).toHaveAttribute(
    'href',
    '?lang=ar#verification-heading',
  );
});
