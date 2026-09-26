import { describe, expect, it } from 'vitest';
import {
  computeActiveConsultationRemainingMinutes,
  computeQueueEtaRange,
  selectConsultationEstimate,
} from '@/modules/queue-eta-estimator';

describe('shared deterministic queue ETA estimator', () => {
  it('prefers three current-session samples over historical evidence', () => {
    expect(selectConsultationEstimate([8, 10, 12], [40, 50, 60])).toEqual({
      estimatedConsultationMinutes: 10,
      estimateSource: 'observed_median',
      observedSampleCount: 3,
    });
  });

  it('uses historical median only when current-session evidence is insufficient', () => {
    expect(selectConsultationEstimate([8, 10], [20, 30, 40])).toEqual({
      estimatedConsultationMinutes: 30,
      estimateSource: 'historical_median',
      observedSampleCount: 2,
    });
  });

  it('clamps samples before taking either median', () => {
    expect(selectConsultationEstimate([], [0.5, 1, 300])).toEqual({
      estimatedConsultationMinutes: 2,
      estimateSource: 'historical_median',
      observedSampleCount: 0,
    });
    expect(selectConsultationEstimate([0.5, 1, 300], [40, 50, 60])).toEqual({
      estimatedConsultationMinutes: 2,
      estimateSource: 'observed_median',
      observedSampleCount: 3,
    });
  });

  it('ignores absent and non-numeric samples instead of counting them at the clamp floor', () => {
    expect(
      selectConsultationEstimate([null, undefined, 'not-a-number'], [20, 30]),
    ).toEqual({
      estimatedConsultationMinutes: 15,
      estimateSource: 'fallback',
      observedSampleCount: 0,
    });
  });

  it('keeps the 15-minute fallback when neither source reaches three samples', () => {
    expect(selectConsultationEstimate([8, 10], [20, 30])).toEqual({
      estimatedConsultationMinutes: 15,
      estimateSource: 'fallback',
      observedSampleCount: 2,
    });
  });

  it('computes bounded active-consultation remaining time from explicit committed time', () => {
    const startedAt = '2026-09-19T12:00:00.000Z';
    expect(
      computeActiveConsultationRemainingMinutes({
        startedAt,
        now: startedAt,
        estimatedConsultationMinutes: 15,
      }),
    ).toBe(15);
    expect(
      computeActiveConsultationRemainingMinutes({
        startedAt,
        now: '2026-09-19T12:05:30.000Z',
        estimatedConsultationMinutes: 15,
      }),
    ).toBe(10);
    expect(
      computeActiveConsultationRemainingMinutes({
        startedAt,
        now: '2026-09-19T12:20:00.000Z',
        estimatedConsultationMinutes: 15,
      }),
    ).toBe(0);
  });

  it('fails closed for invalid or future active-consultation timestamps', () => {
    expect(
      computeActiveConsultationRemainingMinutes({
        startedAt: 'not-a-date',
        now: '2026-09-19T12:00:00.000Z',
        estimatedConsultationMinutes: 15,
      }),
    ).toBe(0);
    expect(
      computeActiveConsultationRemainingMinutes({
        startedAt: '2026-09-19T12:00:00.000Z',
        now: 'not-a-date',
        estimatedConsultationMinutes: 15,
      }),
    ).toBe(0);
    expect(
      computeActiveConsultationRemainingMinutes({
        startedAt: '2026-09-19T12:00:00',
        now: '2026-09-19T12:05:00.000Z',
        estimatedConsultationMinutes: 15,
      }),
    ).toBe(0);
    expect(
      computeActiveConsultationRemainingMinutes({
        startedAt: '2026-02-30T12:00:00.000Z',
        now: '2026-03-02T12:05:00.000Z',
        estimatedConsultationMinutes: 15,
      }),
    ).toBe(0);
    expect(
      computeActiveConsultationRemainingMinutes({
        startedAt: '2026-09-19T12:00:00.000Z',
        now: '2026-09-19T12:05:00',
        estimatedConsultationMinutes: 15,
      }),
    ).toBe(0);
    expect(
      computeActiveConsultationRemainingMinutes({
        startedAt: '2026-09-19T12:01:00.000Z',
        now: '2026-09-19T12:00:00.000Z',
        estimatedConsultationMinutes: 15,
      }),
    ).toBe(0);
  });

  it('accepts only unambiguous absolute timestamps with equivalent offsets and Date values', () => {
    expect(
      computeActiveConsultationRemainingMinutes({
        startedAt: '2026-09-19T16:00:00+04:00',
        now: '2026-09-19T12:05:30.000Z',
        estimatedConsultationMinutes: 15,
      }),
    ).toBe(10);
    expect(
      computeActiveConsultationRemainingMinutes({
        startedAt: new Date('2026-09-19T12:00:00.000Z'),
        now: new Date('2026-09-19T12:05:30.000Z'),
        estimatedConsultationMinutes: 15,
      }),
    ).toBe(10);
    expect(
      computeActiveConsultationRemainingMinutes({
        startedAt: new Date(Number.NaN),
        now: '2026-09-19T12:05:30.000Z',
        estimatedConsultationMinutes: 15,
      }),
    ).toBe(0);
  });

  it('keeps the established declared-delay and uncertainty arithmetic', () => {
    expect(
      computeQueueEtaRange({
        patientsAhead: 2,
        declaredDelayMinutes: 20,
        estimatedConsultationMinutes: 12,
      }),
    ).toEqual({
      minWaitMinutes: 38,
      maxWaitMinutes: 56,
    });
  });

  it('rejects nonphysical numeric inputs before publishing ETA bounds', () => {
    const valid = {
      patientsAhead: 2,
      declaredDelayMinutes: 0,
      estimatedConsultationMinutes: 12,
    };
    const rejects = (input: Parameters<typeof computeQueueEtaRange>[0]) => {
      expect(() => computeQueueEtaRange(input)).toThrow(RangeError);
    };
    const invalidCounts = [
      -1,
      1.5,
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const patientsAhead of invalidCounts) {
      rejects({ ...valid, patientsAhead });
    }
    for (const declaredDelayMinutes of [-1, Number.NaN, Infinity]) {
      rejects({ ...valid, declaredDelayMinutes });
    }
    for (const estimatedConsultationMinutes of [0, -1, Number.NaN, Infinity]) {
      rejects({ ...valid, estimatedConsultationMinutes });
    }
    rejects({
      patientsAhead: Number.MAX_SAFE_INTEGER,
      declaredDelayMinutes: 0,
      estimatedConsultationMinutes: Number.MAX_VALUE,
    });
    expect(computeQueueEtaRange({ ...valid, patientsAhead: 0 })).toEqual({
      minWaitMinutes: 0,
      maxWaitMinutes: 0,
    });
  });

  it('does not treat empty duration text as a clamped observed or historical sample', () => {
    expect(selectConsultationEstimate(['', ' ', '\t'], [20, 30, 40])).toEqual({
      estimatedConsultationMinutes: 30,
      estimateSource: 'historical_median',
      observedSampleCount: 0,
    });
    expect(selectConsultationEstimate([], ['', '   ', '\t'])).toEqual({
      estimatedConsultationMinutes: 15,
      estimateSource: 'fallback',
      observedSampleCount: 0,
    });
    expect(
      selectConsultationEstimate(['', ' 12 ', '14', '16'], [40, 50, 60]),
    ).toEqual({
      estimatedConsultationMinutes: 14,
      estimateSource: 'observed_median',
      observedSampleCount: 3,
    });
  });
});
