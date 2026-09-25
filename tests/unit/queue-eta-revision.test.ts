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
    expect(createEtaRevision(baseline)).toBe(
      createEtaRevision({ ...baseline }),
    );
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

  it('changes when a committed queue/delay version changes with identical rounded ETA', () => {
    const current = {
      ...baseline,
      queueOrderVersion: 21,
      delayVersion: 3,
    };
    expect(createEtaRevision(current)).toBe(createEtaRevision({ ...current }));
    expect(createEtaRevision({ ...current, queueOrderVersion: 22 })).not.toBe(
      createEtaRevision(current),
    );
    expect(createEtaRevision({ ...current, delayVersion: 4 })).not.toBe(
      createEtaRevision(current),
    );
    expect(createEtaRevision(current)).toMatch(/^eta-v2-[0-9a-f]{32}$/);
  });

  it('uses an explicit versioned opaque prefix', () => {
    expect(createEtaRevision(baseline)).toMatch(/^eta-v2-[0-9a-f]{32}$/);
  });

  it('binds the revision to the server-side secret without exposing that secret', () => {
    const previous = process.env.GUEST_BEARER_SIGNING_SECRET;
    try {
      process.env.GUEST_BEARER_SIGNING_SECRET =
        'eta-revision-test-key-A-with-more-than-32-chars';
      const first = createEtaRevision(baseline);
      expect(first).toBe(createEtaRevision({ ...baseline }));

      process.env.GUEST_BEARER_SIGNING_SECRET =
        'eta-revision-test-key-B-with-more-than-32-chars';
      const second = createEtaRevision(baseline);
      expect(second).not.toBe(first);
      expect(second).toMatch(/^eta-v2-[0-9a-f]{32}$/);

      delete process.env.GUEST_BEARER_SIGNING_SECRET;
      expect(() => createEtaRevision(baseline)).toThrow(
        'GUEST_BEARER_SIGNING_SECRET',
      );
    } finally {
      if (previous === undefined) {
        delete process.env.GUEST_BEARER_SIGNING_SECRET;
      } else {
        process.env.GUEST_BEARER_SIGNING_SECRET = previous;
      }
    }
  });
});
