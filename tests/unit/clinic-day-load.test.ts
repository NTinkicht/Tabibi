import { describe, expect, it } from 'vitest';
import {
  assertLoadRehearsalAllowed,
  assertLoadThresholds,
  deterministicRunKey,
  deterministicUuid,
  loadConfig,
  percentile,
  runBounded,
  safeErrorDiagnostic,
  summarizeLoad,
} from '../../scripts/load/clinic-day-lib';

function environment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    TABIBI_ALLOW_LOAD_REHEARSAL: '1',
    ...overrides,
  };
}

describe('clinic-day load rehearsal', () => {
  it('fails closed for unsafe targets and missing opt-in', () => {
    expect(() =>
      assertLoadRehearsalAllowed(
        environment({ TABIBI_ALLOW_LOAD_REHEARSAL: undefined }),
        'postgresql://user:pass@localhost/tabibi_test',
      ),
    ).toThrow(/disabled/i);

    expect(() =>
      assertLoadRehearsalAllowed(
        environment({ NODE_ENV: 'production' }),
        'postgresql://user:pass@localhost/tabibi_test',
      ),
    ).toThrow(/production/i);

    for (const database of ['tabibi', 'prod_latest', 'attestation']) {
      expect(() =>
        assertLoadRehearsalAllowed(
          environment(),
          `postgresql://user:pass@localhost/${database}`,
        ),
      ).toThrow(/explicitly marked/i);
    }

    for (const database of [
      'tabibi_test',
      'tabibi-dev',
      'tabibi_stage',
      'local_tabibi',
      'tabibi-sandbox',
    ]) {
      expect(() =>
        assertLoadRehearsalAllowed(
          environment(),
          `postgresql://user:pass@localhost/${database}`,
        ),
      ).not.toThrow();
    }
  });

  it('enforces bounded configuration caps', () => {
    expect(loadConfig(environment())).toMatchObject({
      seed: 'wu43-clinic-day-v1',
      clinicDayPatients: 12,
      burstPatients: 6,
      concurrency: 4,
      maxDurationMs: 30_000,
      maxP95Ms: 4_000,
    });

    expect(() =>
      loadConfig(environment({ TABIBI_LOAD_CONCURRENCY: '9' })),
    ).toThrow(/between 1 and 8/);
    expect(() =>
      loadConfig(environment({ TABIBI_LOAD_CLINIC_DAY_PATIENTS: '1000' })),
    ).toThrow(/between 4 and 50/);
    expect(() =>
      loadConfig(environment({ TABIBI_LOAD_MAX_DURATION_MS: '120000' })),
    ).toThrow(/between 5000 and 60000/);
  });

  it('derives stable opaque identifiers', () => {
    const first = deterministicUuid('fixed-seed', 'clinic');
    expect(first).toBe(deterministicUuid('fixed-seed', 'clinic'));
    expect(first).not.toBe(deterministicUuid('fixed-seed', 'doctor'));
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(deterministicRunKey('fixed-seed')).toHaveLength(16);
  });

  it('redacts sensitive diagnostic values', () => {
    const diagnostic = safeErrorDiagnostic(
      new Error(
        'failed postgresql://user:secret@localhost/tabibi_test for 123e4567-e89b-12d3-a456-426614174000 patient@example.com +971 50 123 4567',
      ),
    );

    expect(diagnostic).toContain('Error: failed');
    expect(diagnostic).toContain('[database-url]');
    expect(diagnostic).toContain('[uuid]');
    expect(diagnostic).toContain('[email]');
    expect(diagnostic).toContain('[phone]');
    expect(diagnostic).not.toContain('secret');
    expect(diagnostic).not.toContain('patient@example.com');
    expect(diagnostic).not.toContain('123e4567-e89b-12d3-a456-426614174000');
  });

  it('aggregates operational metrics deterministically', () => {
    const samples = [
      {
        phase: 'clinic_day' as const,
        operation: 'read',
        ok: true,
        durationMs: 10,
      },
      {
        phase: 'clinic_day' as const,
        operation: 'read',
        ok: true,
        durationMs: 20,
      },
      {
        phase: 'burst' as const,
        operation: 'write',
        ok: true,
        durationMs: 30,
      },
      {
        phase: 'burst' as const,
        operation: 'write',
        ok: false,
        durationMs: 40,
      },
    ];
    const summary = summarizeLoad(samples, 1_000);

    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
    expect(summary).toMatchObject({
      operations: 4,
      errors: 1,
      errorRate: 0.25,
      durationMs: 1_000,
      throughputPerSecond: 4,
      p50Ms: 20,
      p95Ms: 40,
    });
    const operationNames = summary.byOperation.map((item) => item.operation);
    expect(operationNames).toEqual(['read', 'write']);
    expect(JSON.stringify(summary)).not.toContain('patient');
    expect(JSON.stringify(summary)).not.toContain('cookie');
  });

  it('fails regression thresholds', () => {
    const config = loadConfig(environment());
    const healthy = summarizeLoad(
      [
        {
          phase: 'clinic_day',
          operation: 'read',
          ok: true,
          durationMs: 20,
        },
        { phase: 'burst', operation: 'write', ok: true, durationMs: 30 },
      ],
      100,
    );
    expect(() => assertLoadThresholds(healthy, config)).not.toThrow();

    expect(() =>
      assertLoadThresholds({ ...healthy, errors: 1, errorRate: 0.5 }, config),
    ).toThrow(/failed operations/i);
    expect(() =>
      assertLoadThresholds(
        { ...healthy, durationMs: config.maxDurationMs + 1 },
        config,
      ),
    ).toThrow(/wall-clock/i);
    expect(() =>
      assertLoadThresholds({ ...healthy, p95Ms: config.maxP95Ms + 1 }, config),
    ).toThrow(/p95/i);
  });

  it('bounds concurrent work', async () => {
    let active = 0;
    let maximumActive = 0;
    const completed: number[] = [];

    await runBounded(
      [0, 1, 2, 3, 4, 5],
      2,
      Date.now() + 5_000,
      async (item) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        completed.push(item);
        active -= 1;
      },
    );

    expect(maximumActive).toBeLessThanOrEqual(2);
    const sortedCompleted = completed.sort((left, right) => left - right);
    expect(sortedCompleted).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
