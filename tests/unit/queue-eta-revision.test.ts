import { describe, expect, it } from 'vitest';

import { createEtaRevision } from '@/modules/queue-eta-estimator/revision';

const baseline = {
  patientsAhead: 2,
  declaredDelayMinutes: 5,
  estimatedConsultationMinutes: 15,
  estimateSource: 'observed_median' as const,
  observedSampleCount: 4,
};

describe('WU82 deterministic ETA revision', () => {
  it('returns the same revision for identical committed inputs', () => {
    expect(createEtaRevision(baseline)).toBe(createEtaRevision({ ...baseline }));
  });

  it.each([
    ['patientsAhead', 3],
    ['declaredDelayMinutes', 6],
    ['estimatedConsultationMinutes', 16],
    ['estimateSource', 'historical_median'],
    ['observedSampleCount', 5],
  ] as const)('changes when %s changes', (key, value) => {
    expect(createEtaRevision({ ...baseline, [key]: value })).not.toBe(
      createEtaRevision(baseline),
    );
  });

  it('uses an explicit versioned opaque prefix', () => {
    expect(createEtaRevision(baseline)).toMatch(/^eta-v1-[0-9a-f]{8}$/);
  });
});
