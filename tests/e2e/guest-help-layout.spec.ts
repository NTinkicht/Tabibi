import { expect, test } from '@playwright/test';

const ROUTES = [
  '/guest/help',
  '/guest/booking-help',
  '/guest/booking-contact-help',
  '/guest/notification-help',
  '/guest/privacy-help',
  '/guest/queue-arrival-help',
];

for (const width of [320, 1024]) {
  for (const route of ROUTES) {
    test(`help page ${route} fits ${width}px, mirrors AR and shows clinic footer`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(route);

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      const fr = page.locator('section[lang="fr"][dir="ltr"]');
      const ar = page.locator('section[lang="ar"][dir="rtl"]');
      await expect(fr.getByText('Besoin d’aide à la clinique ?')).toBeVisible();
      await expect(
        ar.getByText('هل تحتاج إلى مساعدة في العيادة؟'),
      ).toBeVisible();
      await expect(fr.getByRole('heading', { level: 1 })).toBeVisible();

      const backFr = fr.getByRole('link', { name: 'Retour à l’aide' });
      if (route === '/guest/help') {
        await expect(backFr).toHaveCount(0);
      } else {
        await expect(backFr).toHaveAttribute('href', '/guest/help');
        const box = await backFr.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        await expect(
          ar.getByRole('link', { name: 'العودة إلى المساعدة' }),
        ).toHaveAttribute('href', '/guest/help');
      }
      expect(await ar.evaluate((el) => getComputedStyle(el).direction)).toBe(
        'rtl',
      );
    });
  }
}
