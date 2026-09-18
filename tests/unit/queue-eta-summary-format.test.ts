import { describe, expect, it } from 'vitest';

import { formatWaitRangeSummary } from '@/modules/queue-eta-estimator';

describe('formatWaitRangeSummary', () => {
  it('preserves validated summary values without rounding or recomputation', () => {
    const summary = {
      midpointMinutes: 12.5,
      uncertaintyWidthMinutes: 7.25,
      confidence: 'medium' as const,
    };

    expect(formatWaitRangeSummary(summary)).toEqual(summary);
    expect(formatWaitRangeSummary(summary)).toEqual(
      formatWaitRangeSummary(summary),
    );
  });

  it.each([
    { midpointMinutes: Number.NaN, uncertaintyWidthMinutes: 1 },
    { midpointMinutes: Number.POSITIVE_INFINITY, uncertaintyWidthMinutes: 1 },
    { midpointMinutes: 1, uncertaintyWidthMinutes: Number.NaN },
    { midpointMinutes: -1, uncertaintyWidthMinutes: 1 },
    { midpointMinutes: 1, uncertaintyWidthMinutes: -1 },
  ])('rejects invalid numeric fields: %o', (invalid) => {
    expect(() =>
      formatWaitRangeSummary({
        ...invalid,
        confidence: 'high',
      }),
    ).toThrow(RangeError);
  });

  it('rejects an invalid confidence value at runtime', () => {
    expect(() =>
      formatWaitRangeSummary({
        midpointMinutes: 10,
        uncertaintyWidthMinutes: 4,
        confidence: 'unknown',
      } as never),
    ).toThrow(RangeError);
  });
});
