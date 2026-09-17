import { describe, expect, it } from 'vitest';

import { isMaterialEstimateChange } from '@/modules/queue-eta-estimator/material-change';

const baseline = {
  minWaitMinutes: 10,
  maxWaitMinutes: 20,
  queuePosition: 5,
  sessionStatus: 'active' as const,
  approachingTurn: false,
};

describe('material estimate change policy', () => {
  it('stays quiet below every default threshold', () => {
    expect(
      isMaterialEstimateChange(baseline, {
        minWaitMinutes: 18,
        maxWaitMinutes: 30,
        queuePosition: 4,
        sessionStatus: 'active',
        approachingTurn: false,
      }),
    ).toBe(false);
  });

  it.each([
    [{ ...baseline, minWaitMinutes: 20, maxWaitMinutes: 30 }, 'midpoint'],
    [{ ...baseline, minWaitMinutes: 5, maxWaitMinutes: 30 }, 'uncertainty'],
    [{ ...baseline, queuePosition: 3 }, 'queue position'],
    [{ ...baseline, sessionStatus: 'delayed' as const }, 'delay'],
    [{ ...baseline, sessionStatus: 'cancelled' as const }, 'cancellation'],
    [{ ...baseline, approachingTurn: true }, 'approaching turn'],
  ])('marks %s as material (%s)', (current) => {
    expect(isMaterialEstimateChange(baseline, current)).toBe(true);
  });
});
