import { defineConfig, defineProject } from 'vitest/config';
import { resolve } from 'node:path';

const common = { resolve: { alias: { '@': resolve(__dirname, 'src') } } };
export default defineConfig({
  test: {
    // Integration files share one real PostgreSQL schema and perform
    // destructive cleanup. Vitest 3 only supports this setting globally (not
    // per ProjectConfig), so serialize files to keep the integration project
    // deterministic while purpose-built concurrency remains inside tests.
    fileParallelism: false,
    projects: [
      defineProject({
        ...common,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      }),
      defineProject({
        ...common,
        test: {
          name: 'api',
          include: ['tests/api/**/*.test.ts'],
          environment: 'node',
        },
      }),
      defineProject({
        ...common,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 15_000,
        },
      }),
    ],
  },
});
