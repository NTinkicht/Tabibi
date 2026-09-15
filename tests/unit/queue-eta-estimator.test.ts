import { describe, expect, it } from 'vitest';
import {
  computeQueueEtaRange,
  selectConsultationEstimate,
} from '@/modules/queue-eta-estimator';

describe('shared deterministic queue ETA estimator', () => {
  it('prefers three current-session samples over historical evidence', () => {
    expect(
      selectConsultationEstimate([8, 10, 12], [40, 50, 60]),
    ).toEqual({
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

  it('keeps the 15-minute fallback when neither source reaches three samples', () => {
    expect(selectConsultationEstimate([8, 10], [20, 30])).toEqual({
      estimatedConsultationMinutes: 15,
      estimateSource: 'fallback',
      observedSampleCount: 2,
    });
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
