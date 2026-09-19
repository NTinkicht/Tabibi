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
        startedAt: '2026-09-19T12:01:00.000Z',
        now: '2026-09-19T12:00:00.000Z',
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
});