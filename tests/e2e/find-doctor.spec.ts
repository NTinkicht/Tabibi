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
