import { createHash } from 'node:crypto';

export const LOAD_OPT_IN = 'TABIBI_ALLOW_LOAD_REHEARSAL';

export interface ClinicDayLoadConfig {
  seed: string;
  clinicDayPatients: number;
  burstPatients: number;
  concurrency: number;
  maxDurationMs: number;
  maxP95Ms: number;
}

export interface LoadSample {
  phase: 'clinic_day' | 'burst';
  operation: string;
  ok: boolean;
  durationMs: number;
}

export interface OperationMetrics {
  operation: string;
  count: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface LoadSummary {
  operations: number;
  errors: number;
  errorRate: number;
  durationMs: number;
  throughputPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  byOperation: OperationMetrics[];
}

const NON_PRODUCTION_DATABASE_PATTERN =
  /(^|[_-])(test|dev|stage|staging|local|sandbox)([_-]|$)/i;

function integerFromEnvironment(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): ClinicDayLoadConfig {
  const seed = env.TABIBI_LOAD_SEED?.trim() || 'wu43-clinic-day-v1';
  if (seed.length > 80) {
    throw new Error('TABIBI_LOAD_SEED must be at most 80 characters');
  }

  return {
    seed,
    clinicDayPatients: integerFromEnvironment(
      env,
      'TABIBI_LOAD_CLINIC_DAY_PATIENTS',
      12,
      4,
      50,
    ),
    burstPatients: integerFromEnvironment(
      env,
      'TABIBI_LOAD_BURST_PATIENTS',
      6,
      2,
      20,
    ),
    concurrency: integerFromEnvironment(
      env,
      'TABIBI_LOAD_CONCURRENCY',
      4,
      1,
      8,
    ),
    maxDurationMs: integerFromEnvironment(
      env,
      'TABIBI_LOAD_MAX_DURATION_MS',
      30_000,
      5_000,
      60_000,
    ),
    maxP95Ms: integerFromEnvironment(
      env,
      'TABIBI_LOAD_MAX_P95_MS',
      4_000,
      100,
      10_000,
    ),
  };
}

export function assertLoadRehearsalAllowed(
  env: NodeJS.ProcessEnv,
  databaseUrl: string,
): void {
  if (env[LOAD_OPT_IN] !== '1') {
    throw new Error(
      `Load rehearsal is disabled; set ${LOAD_OPT_IN}=1 explicitly`,
    );
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('Load rehearsal refuses to run with NODE_ENV=production');
  }

  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  const databaseName = decodeURIComponent(
    parsed.pathname.replace(/^\//, ''),
  ).toLowerCase();
  if (!databaseName || !NON_PRODUCTION_DATABASE_PATTERN.test(databaseName)) {
    throw new Error(
      'Load rehearsal requires a database name explicitly marked test/dev/stage/staging/local/sandbox',
    );
  }
}

export function safeErrorDiagnostic(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const raw =
    error instanceof Error ? error.message : 'Unknown load operation failure';
  const sanitized = raw
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url]')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '[uuid]',
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      '[email]',
    )
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[phone]');
  return `${name}: ${sanitized.slice(0, 200)}`;
}

export function deterministicUuid(seed: string, label: string): string {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(`${seed}:${label}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deterministicRunKey(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

export function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * ratio) - 1,
  );
  return Math.round(sorted[Math.max(0, index)]! * 100) / 100;
}

function metricsFor(
  operation: string,
  samples: readonly LoadSample[],
): OperationMetrics {
  const relevant = samples.filter((sample) => sample.operation === operation);
  const durations = relevant.map((sample) => sample.durationMs);
  const errors = relevant.filter((sample) => !sample.ok).length;
  return {
    operation,
    count: relevant.length,
    errors,
    errorRate: relevant.length === 0 ? 0 : errors / relevant.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
  };
}

export function summarizeLoad(
  samples: readonly LoadSample[],
  durationMs: number,
): LoadSummary {
  const durations = samples.map((sample) => sample.durationMs);
  const errors = samples.filter((sample) => !sample.ok).length;
  const operations = [
    ...new Set(samples.map((sample) => sample.operation)),
  ].sort();
  return {
    operations: samples.length,
    errors,
    errorRate: samples.length === 0 ? 0 : errors / samples.length,
    durationMs,
    throughputPerSecond:
      durationMs <= 0
        ? 0
        : Math.round((samples.length / (durationMs / 1_000)) * 100) / 100,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    byOperation: operations.map((operation) => metricsFor(operation, samples)),
  };
}

export function assertLoadThresholds(
  summary: LoadSummary,
  config: ClinicDayLoadConfig,
): void {
  if (summary.operations === 0) {
    throw new Error('Load rehearsal produced no operations');
  }
  if (summary.errors > 0) {
    throw new Error(`Load rehearsal recorded ${summary.errors} failed operations`);
  }
  if (summary.durationMs > config.maxDurationMs) {
    throw new Error(
      `Load rehearsal exceeded wall-clock bound: ${summary.durationMs}ms > ${config.maxDurationMs}ms`,
    );
  }
  if (summary.p95Ms > config.maxP95Ms) {
    throw new Error(
      `Load rehearsal p95 exceeded regression threshold: ${summary.p95Ms}ms`,
    );
  }
}

export async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  deadlineMs: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        if (Date.now() > deadlineMs) {
          throw new Error('Load rehearsal exceeded wall-clock deadline');
        }
        const index = cursor++;
        await work(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
}
