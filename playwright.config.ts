import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: 'http://127.0.0.1:3000' },
  webServer: {
    command: 'npm run start',
    url: 'http://127.0.0.1:3000/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://tabibi:tabibi_dev_only@localhost:5432/tabibi',
      STAFF_SESSION_SECRET:
        process.env.STAFF_SESSION_SECRET ??
        'browser-test-session-secret-at-least-32-characters',
    },
  },
});
