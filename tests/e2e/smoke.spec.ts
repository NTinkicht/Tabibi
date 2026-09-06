import { expect, test } from '@playwright/test';

test('application shell and liveness endpoint are available', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tabibi' })).toBeVisible();
  const health = await request.get('/api/health');
  expect(health.ok()).toBe(true);
  await expect(health.json()).resolves.toMatchObject({
    status: 'ok',
    service: 'tabibi',
  });
});
