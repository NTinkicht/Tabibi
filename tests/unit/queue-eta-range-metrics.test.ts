import { describe, expect, it } from 'vitest';

import { deriveWaitRangeMetrics } from '@/modules/queue-eta-estimator/range-metrics';

describe('deriveWaitRangeMetrics', () => {
  it('derives midpoint and uncertainty width for a valid range', () => {
    expect(
      deriveWaitRangeMetrics({ minWaitMinutes: 10, maxWaitMinutes: 30 }),
    ).toEqual({
      midpointMinutes: 20,
      uncertaintyWidthMinutes: 20,
    });
  });

  it('handles large finite bounds without overflowing the midpoint', () => {
    const max = Number.MAX_VALUE;
    const min = max / 2;

    const metrics = deriveWaitRangeMetrics({
      minWaitMinutes: min,
      maxWaitMinutes: max,
    });

    expect(Number.isFinite(metrics.midpointMinutes)).toBe(true);
    expect(metrics.midpointMinutes).toBe(min + (max - min) / 2);
    expect(metrics.uncertaintyWidthMinutes).toBe(max - min);
  });

  it.each([
    { minWaitMinutes: Number.NaN, maxWaitMinutes: 10 },
    { minWaitMinutes: 0, maxWaitMinutes: Number.POSITIVE_INFINITY },
  ])('rejects non-finite bounds: %o', (range) => {
    expect(() => deriveWaitRangeMetrics(range)).toThrow(RangeError);
  });

  it.each([
    { minWaitMinutes: -1, maxWaitMinutes: 10 },
    { minWaitMinutes: 0, maxWaitMinutes: -1 },
  ])('rejects negative bounds: %o', (range) => {
    expect(() => deriveWaitRangeMetrics(range)).toThrow(RangeError);
  });

  it('rejects an inverted range', () => {
    expect(() =>
      deriveWaitRangeMetrics({ minWaitMinutes: 11, maxWaitMinutes: 10 }),
    ).toThrow(RangeError);
  });
});
