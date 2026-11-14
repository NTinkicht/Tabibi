import { expect, test, type Page } from '@playwright/test';

const REF = 'v1.AbCdEfGh12.sealed_ref-1';
const clinic = (withSessions: boolean) => ({
  name: 'Clinique du Centre',
  defaultLocale: 'fr',
  enabledLocales: ['fr', 'ar'],
  wilayaCode: '09',
  commune: 'Blida',
  addressLine: '1 rue des Roses',
  doctors: [
    {
      displayName: 'Dr Amine',
      specialtyCodes: [],
      ...(withSessions
        ? {
            sessions: [
              {
                serviceDate: '2026-11-20',
                startsAt: '2026-11-20T08:00:00.000Z',
                endsAt: '2026-11-20T12:00:00.000Z',
                selectionReference: REF,
              },
            ],
          }
        : {}),
    },
  ],
});

async function mock(page: Page, seen: string[]) {
  await page.route('**/api/public/bookable-sessions*', (route) => {
    seen.push(route.request().url());
    return route.fulfill({
      json: { page: 1, hasMore: false, clinics: [clinic(true)] },
    });
  });
  await page.route('**/api/public/discovery*', (route) => {
    seen.push(route.request().url());
    return route.fulfill({
      json: { page: 1, hasMore: false, clinics: [clinic(false)] },
    });
  });
}

const viewports = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

for (const language of ['fr', 'ar'] as const) {
  for (const viewport of viewports) {
    test(`find a doctor ${language} ${viewport.width}px: filter, modes, sessions to booking`, async ({
      page,
    }) => {
      await page.addInitScript(
        (value) => {
          Object.defineProperty(navigator, 'language', {
            configurable: true,
            value,
          });
        },
        language === 'ar' ? 'ar-DZ' : 'fr-FR',
      );
      await page.setViewportSize(viewport);
      const seen: string[] = [];
      await mock(page, seen);
      await page.goto('/find');
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await expect(page.locator('html')).toHaveAttribute(
        'dir',
        language === 'ar' ? 'rtl' : 'ltr',
      );

      // The server render may hold real (here empty) data; switching modes
      // makes the page load from the mocked APIs in either environment.
      const modeButton = (name: string) => page.getByRole('button', { name });
      await modeButton(
        language === 'ar' ? 'كل العيادات' : 'Tous les cabinets',
      ).click();
      await modeButton(
        language === 'ar' ? 'الحجز عبر الإنترنت' : 'Réserver en ligne',
      ).click();

      // Default mode is booking: next session line and sessions button.
      const viewButton = page.getByRole('button', {
        name: language === 'ar' ? 'عرض الجلسات' : 'Voir les sessions',
      });
      await expect(viewButton).toBeVisible();
      await expect(page.getByText(/Dr Amine/)).toBeVisible();

      // Wilaya filter reaches the bookable-sessions API as a query.
      await page.getByRole('combobox').nth(1).selectOption('09');
      await expect
        .poll(() => seen.some((u) => u.includes('wilaya=09')))
        .toBe(true);
      expect(seen[seen.length - 1]).toContain('/api/public/bookable-sessions');

      // Sessions view; Réserver navigates to the booking route.
      await viewButton.click();
      const book = page.getByRole('link', {
        name: language === 'ar' ? 'احجز' : 'Réserver',
      });
      await expect(book).toHaveAttribute('href', `/guest/live-queue/${REF}`);
      // No horizontal scroll at this viewport.
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await page
        .getByRole('button', {
          name:
            language === 'ar' ? 'العودة إلى النتائج' : 'Retour aux résultats',
        })
        .click();

      // Directory mode: discovery only, no booking button or session line.
      await page
        .getByRole('button', {
          name: language === 'ar' ? 'كل العيادات' : 'Tous les cabinets',
        })
        .click();
      await expect(page.getByText('Dr Amine')).toBeVisible();
      await expect(viewButton).toHaveCount(0);
      await expect(
        page.getByText(
          language === 'ar' ? 'الجلسة القادمة' : 'Prochaine session',
        ),
      ).toHaveCount(0);
      expect(seen[seen.length - 1]).toContain('/api/public/discovery');
    });
  }
}

// Pagination, stale responses and error recovery (fr, phone width).
const named = (name: string, ref: string) => ({
  ...clinic(true),
  name,
  doctors: [{ ...clinic(true).doctors[0], displayName: `Dr ${name}` }].map(
    (d) => ({
      ...d,
      sessions: [{ ...d.sessions![0], selectionReference: ref }],
    }),
  ),
});

test.describe('find doctor paging and recovery', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'language', {
        configurable: true,
        value: 'fr-FR',
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
  });
  const count = (page: Page, n: number) =>
    expect(page.getByRole('status').first()).toHaveText(
      `${n} cabinet${n === 1 ? '' : 's'} trouvé${n === 1 ? '' : 's'}`,
    );

  test('Plus de résultats appends the next page', async ({ page }) => {
    const urls: string[] = [];
    await page.route('**/api/public/bookable-sessions*', (route) => {
      const u = route.request().url();
      urls.push(u);
      const second = u.includes('page=2');
      return route.fulfill({
        json: {
          page: second ? 2 : 1,
          hasMore: !second,
          clinics: [named(second ? 'Deux' : 'Un', 'v1.pageref0000.a')],
        },
      });
    });
    await page.goto('/find');
    await page.getByRole('button', { name: 'Tous les cabinets' }).click();
    await page.getByRole('button', { name: 'Réserver en ligne' }).click();
    await count(page, 1);
    await page.getByRole('button', { name: 'Plus de résultats' }).click();
    await count(page, 2);
    await expect(page.getByText('Dr Un')).toBeVisible();
    await expect(page.getByText('Dr Deux')).toBeVisible();
    expect(urls.some((u) => u.includes('page=2'))).toBe(true);
    await expect(
      page.getByRole('button', { name: 'Plus de résultats' }),
    ).toHaveCount(0);
  });

  test('a stale page 2 is dropped after a filter change', async ({ page }) => {
    let releasePage2: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releasePage2 = resolve));
    await page.route('**/api/public/bookable-sessions*', async (route) => {
      const u = route.request().url();
      if (u.includes('page=2')) {
        await gate;
        return route.fulfill({
          json: {
            page: 2,
            hasMore: false,
            clinics: [named('Perime', 'v1.staleref000.a')],
          },
        });
      }
      const filtered = u.includes('wilaya=09');
      return route.fulfill({
        json: {
          page: 1,
          hasMore: !filtered,
          clinics: [named(filtered ? 'Filtre' : 'Un', 'v1.pageref0000.a')],
        },
      });
    });
    await page.goto('/find');
    await page.getByRole('button', { name: 'Tous les cabinets' }).click();
    await page.getByRole('button', { name: 'Réserver en ligne' }).click();
    await count(page, 1);
    await page.getByRole('button', { name: 'Plus de résultats' }).click();
    await page.getByRole('combobox').nth(1).selectOption('09');
    await expect(page.getByText('Dr Filtre')).toBeVisible();
    releasePage2();
    await page.waitForTimeout(300);
    await expect(page.getByText('Dr Perime')).toHaveCount(0);
    await count(page, 1);
  });

  test('re-selecting the current mode does not leave a stuck spinner', async ({
    page,
  }) => {
    await page.route('**/api/public/bookable-sessions*', (route) =>
      route.fulfill({
        json: {
          page: 1,
          hasMore: false,
          clinics: [named('Un', 'v1.pageref0000.a')],
        },
      }),
    );
    await page.goto('/find');
    await page.getByRole('button', { name: 'Tous les cabinets' }).click();
    await page.getByRole('button', { name: 'Réserver en ligne' }).click();
    await count(page, 1);
    await page.getByRole('button', { name: 'Réserver en ligne' }).click();
    await count(page, 1);
  });

  test('an API error offers a retry that recovers', async ({ page }) => {
    let failing = false;
    await page.route('**/api/public/discovery*', (route) =>
      route.fulfill({ json: { page: 1, hasMore: false, clinics: [] } }),
    );
    await page.route('**/api/public/bookable-sessions*', (route) =>
      failing
        ? route.fulfill({ status: 503, json: {} })
        : route.fulfill({
            json: {
              page: 1,
              hasMore: false,
              clinics: [named('Un', 'v1.pageref0000.a')],
            },
          }),
    );
    await page.goto('/find');
    await page.getByRole('button', { name: 'Tous les cabinets' }).click();
    failing = true;
    await page.getByRole('button', { name: 'Réserver en ligne' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    failing = false;
    await page.getByRole('button', { name: 'Réessayer' }).click();
    await count(page, 1);
  });
});
