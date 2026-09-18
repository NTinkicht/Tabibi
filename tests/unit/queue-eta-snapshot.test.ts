import { describe, expect, it } from 'vitest';

import { createEtaSnapshot } from '@/modules/queue-eta-estimator/snapshot';

const baseline = {
  patientsAhead: 2,
  declaredDelayMinutes: 5,
  estimatedConsultationMinutes: 15,
  estimateSource: 'observed_median' as const,
  observedSampleCount: 4,
};

describe('WU83 deterministic ETA snapshot', () => {
  it('composes the established wait range with a revision token', () => {
    expect(createEtaSnapshot(baseline)).toEqual({
      minWaitMinutes: 28,
      maxWaitMinutes: 50,
      revision: createEtaSnapshot(baseline).revision,
    });
    expect(createEtaSnapshot(baseline).revision).toMatch(/^eta-v1-[0-9a-f]{8}$/);
  });

  it('is deterministic for identical committed inputs', () => {
    expect(createEtaSnapshot(baseline)).toEqual(createEtaSnapshot({ ...baseline }));
  });

  it('changes revision when committed estimator evidence changes', () => {
    expect(createEtaSnapshot({ ...baseline, patientsAhead: 3 }).revision).not.toBe(
      createEtaSnapshot(baseline).revision,
    );
  });

  it('returns a runtime-immutable snapshot', () => {
    const snapshot = createEtaSnapshot(baseline);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as { minWaitMinutes: number }).minWaitMinutes = 999;
    }).toThrow(TypeError);
    expect(snapshot.minWaitMinutes).toBe(28);
  });
});
