import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type Environment = z.infer<typeof schema>;

let cached: Environment | undefined;

export function getEnvironment(
  source: Record<string, string | undefined> = process.env,
): Environment {
  if (source === process.env && cached) return cached;
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration: ${z.prettifyError(result.error)}`,
    );
  }
  if (source === process.env) cached = result.data;
  return result.data;
}

export function resetEnvironmentForTests(): void {
  cached = undefined;
}
