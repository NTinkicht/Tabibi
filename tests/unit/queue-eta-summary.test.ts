import { describe, expect, it } from 'vitest';

import { summarizeWaitRange } from '@/modules/queue-eta-estimator';

const thresholds = {
  highMaxWidthMinutes: 10,
  mediumMaxWidthMinutes: 25,
};

describe('summarizeWaitRange', () => {
  it('composes midpoint, exact uncertainty width, and high confidence', () => {
    expect(
      summarizeWaitRange({ minWaitMinutes: 5, maxWaitMinutes: 15 }, thresholds),
    ).toEqual({
      midpointMinutes: 10,
      uncertaintyWidthMinutes: 10,
      confidence: 'high',
    });
  });

  it('classifies the exact derived width as medium', () => {
    expect(
      summarizeWaitRange({ minWaitMinutes: 5, maxWaitMinutes: 20 }, thresholds),
    ).toEqual({
      midpointMinutes: 12.5,
      uncertaintyWidthMinutes: 15,
      confidence: 'medium',
    });
  });

  it('classifies the exact derived width as low', () => {
    expect(
      summarizeWaitRange({ minWaitMinutes: 5, maxWaitMinutes: 35 }, thresholds),
    ).toEqual({
      midpointMinutes: 20,
      uncertaintyWidthMinutes: 30,
      confidence: 'low',
    });
  });

  it('fails closed when the wait range is invalid', () => {
    expect(() =>
      summarizeWaitRange(
        { minWaitMinutes: 30, maxWaitMinutes: 10 },
        thresholds,
      ),
    ).toThrow(RangeError);
  });

  it('fails closed when confidence thresholds are invalid', () => {
    expect(() =>
      summarizeWaitRange(
        { minWaitMinutes: 5, maxWaitMinutes: 15 },
        { highMaxWidthMinutes: 30, mediumMaxWidthMinutes: 20 },
      ),
    ).toThrow(RangeError);
  });
});
