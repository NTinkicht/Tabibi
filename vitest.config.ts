import { defineConfig, defineProject } from 'vitest/config';
import { resolve } from 'node:path';

const common = { resolve: { alias: { '@': resolve(__dirname, 'src') } } };
export default defineConfig({
  test: {
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
          fileParallelism: false,
        },
      }),
    ],
  },
});
