import { describe, expect, it } from 'vitest';

import {
  isMaterialEstimateChange,
  type QueueEstimateSnapshot,
} from '@/modules/queue-eta-estimator/material-change';

const baseline: QueueEstimateSnapshot = {
  minWaitMinutes: 10,
  maxWaitMinutes: 20,
  queuePosition: 5,
  sessionStatus: 'active',
  approachingTurn: false,
};

type MaterialChangeCase = [QueueEstimateSnapshot, string];

const materialChangeCases: MaterialChangeCase[] = [
  [{ ...baseline, minWaitMinutes: 20, maxWaitMinutes: 30 }, 'midpoint'],
  [{ ...baseline, minWaitMinutes: 5, maxWaitMinutes: 30 }, 'uncertainty'],
  [{ ...baseline, queuePosition: 3 }, 'queue position'],
  [{ ...baseline, sessionStatus: 'delayed' }, 'delay'],
  [{ ...baseline, sessionStatus: 'cancelled' }, 'cancellation'],
  [{ ...baseline, approachingTurn: true }, 'approaching turn'],
];

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

  it.each(materialChangeCases)(
    'marks %s as material (%s)',
    (current) => {
      expect(isMaterialEstimateChange(baseline, current)).toBe(true);
    },
  );
});
