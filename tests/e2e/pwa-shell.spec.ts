import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 320, height: 640 } });

test('manifest is served with the right lang and dir for fr and ar', async ({
  request,
}) => {
  const fr = await request.get('/manifest.webmanifest');
  expect(fr.status()).toBe(200);
  expect(await fr.json()).toMatchObject({ lang: 'fr', dir: 'ltr' });
  const ar = await request.get('/manifest.webmanifest?locale=ar');
  expect(await ar.json()).toMatchObject({ lang: 'ar', dir: 'rtl' });
});

test('service worker is served with no-cache and root scope', async ({
  request,
}) => {
  const res = await request.get('/sw.js');
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('no-cache');
  expect(res.headers()['service-worker-allowed']).toBe('/');
});

test('guest status registers the worker with root scope and caches nothing', async ({
  page,
}) => {
  await page.route('**/api/guest/status', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
  await page.goto('/guest/status');
  const scope = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.scope;
  });
  expect(new URL(scope).pathname).toBe('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    /\/manifest\.webmanifest\?locale=(fr|ar)/,
  );
  const cacheNames = await page.evaluate(() => caches.keys());
  expect(cacheNames).toEqual([]);
  const hasFetchHandler = await page.evaluate(async () => {
    const res = await fetch('/sw.js');
    return /addEventListener\(\s*'fetch'/.test(await res.text());
  });
  expect(hasFetchHandler).toBe(false);
});

test('operations never registers the worker', async ({ page }) => {
  await page.goto('/operations');
  const registrations = await page.evaluate(
    async () => (await navigator.serviceWorker.getRegistrations()).length,
  );
  expect(registrations).toBe(0);
});
