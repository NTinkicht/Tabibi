import { expect, test, type Page } from '@playwright/test';

// TAB-P0-14: public pages swept across locale x viewport width. Each page is
// held to the same structural accessibility invariants instead of per-spec
// spot checks.
const WIDTHS = [320, 768, 1280] as const;
const LOCALES = ['fr', 'ar'] as const;
type Locale = (typeof LOCALES)[number];
const dirOf = (l: Locale) => (l === 'ar' ? 'rtl' : 'ltr');

interface Audit {
  overflow: boolean;
  mains: number;
  h1s: number;
  unnamed: string[];
}

// Runs in the page. Accessible name = aria-label, aria-labelledby target text,
// associated <label>, visible text, alt/title, or a named image/svg child.
function auditDocument(): Audit {
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  };
  const text = (el: Element | null) => (el?.textContent ?? '').trim();
  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label')?.trim();
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const joined = by
        .split(/\s+/)
        .map((id) => text(document.getElementById(id)))
        .join(' ')
        .trim();
      if (joined) return joined;
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      const t = Array.from(labels).map(text).join(' ').trim();
      if (t) return t;
    }
    if (text(el)) return text(el);
    const title = el.getAttribute('title')?.trim();
    if (title) return title;
    const img = el.querySelector('img[alt]');
    if (img?.getAttribute('alt')?.trim()) return 'img';
    return '';
  };
  const controls = Array.from(
    document.querySelectorAll(
      'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link]',
    ),
  ).filter(visible);
  return {
    overflow:
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
    mains: document.querySelectorAll('main, [role=main]').length,
    h1s: Array.from(document.querySelectorAll('h1')).filter(visible).length,
    unnamed: controls
      .filter((el) => !nameOf(el))
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`),
  };
}

async function expectAccessible(page: Page) {
  const audit = await page.evaluate(auditDocument);
  expect(audit.overflow, 'horizontal page overflow').toBe(false);
  expect(audit.mains, 'main landmarks').toBe(1);
  expect(audit.h1s, 'visible h1 headings').toBeGreaterThanOrEqual(1);
  expect(audit.unnamed, 'controls without an accessible name').toEqual([]);
}

test('positive control: the audit flags overflow, missing names and landmarks', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.setContent(
    `<html><body>
       <div style="width:900px">wide</div>
       <button></button><a href="/x"></a><input type="text" />
     </body></html>`,
  );
  const audit = await page.evaluate(auditDocument);
  expect(audit.overflow).toBe(true);
  expect(audit.mains).toBe(0);
  expect(audit.h1s).toBe(0);
  expect(audit.unnamed).toEqual(['button', 'a', 'input']);

  await page.setContent(
    `<html><body><main><h1>T</h1>
       <button aria-label="ok"></button><label>Nom<input type="text" /></label>
     </main></body></html>`,
  );
  const clean = await page.evaluate(auditDocument);
  expect(clean).toEqual({ overflow: false, mains: 1, h1s: 1, unnamed: [] });
});

for (const locale of LOCALES) {
  for (const width of WIDTHS) {
    test.describe(`${locale} at ${width}px`, () => {
      test.use({ viewport: { width, height: 800 } });

      const single: Array<[string, string]> = [
        ['staff sign-in', `/staff/sign-in?locale=${locale}`],
        ['ETA explainer', `/guest/eta-explained?lang=${locale}`],
      ];
      for (const [label, url] of single) {
        test(`${label} sets lang/dir and passes the audit`, async ({
          page,
        }) => {
          await page.goto(url);
          const html = page.locator('html');
          await expect(html).toHaveAttribute('lang', locale);
          await expect(html).toHaveAttribute('dir', dirOf(locale));
          await expectAccessible(page);
        });
      }

      test('find a doctor passes the audit with mocked discovery', async ({
        page,
      }) => {
        await page.addInitScript(
          (value) => {
            Object.defineProperty(navigator, 'language', {
              configurable: true,
              value,
            });
          },
          locale === 'ar' ? 'ar-DZ' : 'fr-FR',
        );
        await page.route('**/api/public/**', (route) =>
          route.fulfill({
            json: { page: 1, hasMore: false, clinics: [] },
          }),
        );
        await page.goto('/');
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.locator('html')).toHaveAttribute(
          'dir',
          dirOf(locale),
        );
        await expectAccessible(page);
      });
    });
  }
}

// Bilingual static guidance pages carry both languages in one document; each
// language section must declare its own lang/dir pair.
const bilingual = [
  '/guest/help',
  '/guest/privacy-help',
  '/guest/booking-help',
  '/guest/queue-next-steps',
];
for (const width of WIDTHS) {
  test.describe(`bilingual guidance at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });
    for (const url of bilingual) {
      test(`${url} has fr/ltr and ar/rtl sections and passes the audit`, async ({
        page,
      }) => {
        await page.goto(url);
        await expect(page.locator('section[lang="fr"][dir="ltr"]')).toHaveCount(
          1,
        );
        await expect(page.locator('section[lang="ar"][dir="rtl"]')).toHaveCount(
          1,
        );
        await expectAccessible(page);
      });
    }
  });
}
