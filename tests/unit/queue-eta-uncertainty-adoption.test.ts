import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeEtaUncertaintyV1,
  isEtaUncertaintySnapshotForRevision,
  type EtaUncertaintyInput,
} from '@/modules/queue-eta-estimator/uncertainty-v1';

const fixturePath = resolve(
  process.cwd(),
  'tests/fixtures/eta-uncertainty-v1.vectors.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const scope = {
  clinicId: 'clinic-1',
  sessionId: 'session-1',
  targetEntryId: 'entry-1',
  estimateSource: 'fallback' as const,
  sessionStatus: 'open' as const,
};

function adapt(input: Record<string, unknown>): EtaUncertaintyInput {
  return {
    ...scope,
    queueRevision: input.queueRevision as number,
    evaluatedAt: input.evaluatedAt as string,
    declaredDelayMinutes: input.declaredDelay as number,
    activeConsultationRemainingMinutes: input.activeRemaining as number,
    slotsAhead: input.slotsAhead as number,
    estimatedConsultationMinutes: input.estimatedConsultation as number,
  };
}

const valid = adapt({
  declaredDelay: 0,
  activeRemaining: 0,
  slotsAhead: 1,
  estimatedConsultation: 10,
  queueRevision: 41,
  evaluatedAt: '2026-10-04T10:00:00Z',
});

describe('ETA uncertainty-v1 adoption', () => {
  for (const vector of fixture.cases) {
    if (vector.kind !== 'estimate' && vector.kind !== 'retry') continue;

    it(vector.id + ': follows committed acceptance vectors', () => {
      const input = adapt(vector.input);
      const first = computeEtaUncertaintyV1(input);
      const second = computeEtaUncertaintyV1({ ...input });
      const expected = { ...vector.expected };
      delete expected.byteEquivalentOnRetry;
      delete expected.explanationCodes;
      const codes = [...vector.expected.explanationCodes, 'fallback'];

      expect(first).toMatchObject(expected);
      expect(first.explanationCodes).toEqual(codes);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.explanationCodes)).toBe(true);
    });
  }

  it('preserves uncertainty through outward rounding', () => {
    const estimate = computeEtaUncertaintyV1({
      ...valid,
      declaredDelayMinutes: 0.8,
      estimatedConsultationMinutes: 1,
    });
    const bounds = [
      estimate.earliestMinutes,
      estimate.expectedMinutes,
      estimate.latestMinutes,
    ];
    expect(bounds).toEqual([1, 2, 3]);
  });

  it('counts called and active work exactly once', () => {
    const called = computeEtaUncertaintyV1({
      ...valid,
      slotsAhead: 2,
      calledNotStartedAhead: 1,
    });
    const active = computeEtaUncertaintyV1({
      ...valid,
      slotsAhead: 2,
      activeSlotIncludedInAhead: true,
      activeConsultationRemainingMinutes: 4,
    });
    expect(called.expectedMinutes).toBe(20);
    expect(called.explanationCodes).toContain('called-not-started');
    expect(active.expectedMinutes).toBe(14);
    expect(active.explanationCodes).toContain('active-consultation-remaining');
  });

  it('explains a completed-or-overrun active slot even with zero remaining', () => {
    const overrun = computeEtaUncertaintyV1({
      ...valid,
      slotsAhead: 1,
      activeSlotIncludedInAhead: true,
      activeConsultationRemainingMinutes: 0,
    });
    expect(overrun.earliestMinutes).toBe(0);
    expect(overrun.expectedMinutes).toBe(0);
    expect(overrun.latestMinutes).toBe(0);
    expect(overrun.explanationCodes).toContain('active-consultation-overrun');
    expect(overrun.explanationCodes).not.toContain('active-consultation-remaining');
    expect(overrun.explanationCodes).not.toContain('queue-depth');
    const replay = computeEtaUncertaintyV1({
      ...valid,
      slotsAhead: 1,
      activeSlotIncludedInAhead: true,
      activeConsultationRemainingMinutes: 0,
    });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(overrun));
  });

  it('validates read-only snapshot revisions without claiming atomic publication', () => {
    const estimate = computeEtaUncertaintyV1(valid);
    expect(isEtaUncertaintySnapshotForRevision(estimate, 42)).toBe(false);
    expect(isEtaUncertaintySnapshotForRevision(estimate, 41)).toBe(true);
    expect(isEtaUncertaintySnapshotForRevision(estimate, -1)).toBe(false);
    expect(isEtaUncertaintySnapshotForRevision(estimate, 41.1)).toBe(false);
    expect(isEtaUncertaintySnapshotForRevision(estimate, Number.NaN)).toBe(
      false,
    );
    // No persistence or fresh source-epoch read occurs in this pure helper.
    // A matching number is necessary for internal consistency but cannot
    // prove that delay, completion, or other ETA sources have not advanced.
  });

  it('rejects impossible calendar dates', () => {
    const malformed = [
      '2026-02-31T10:00:00Z',
      '2026-04-31T10:00:00Z',
      '2026-13-01T10:00:00Z',
    ];
    for (const evaluatedAt of malformed) {
      const input = { ...valid, evaluatedAt };
      expect(() => computeEtaUncertaintyV1(input)).toThrow(RangeError);
    }
  });

  it('rejects all invalid committed vectors', () => {
    for (const vector of fixture.invalidInputs) {
      const input = adapt(vector.input);
      expect(() => computeEtaUncertaintyV1(input)).toThrow(RangeError);
    }
  });

  it('rejects paused, missing-scope and contradictory inputs', () => {
    const paused = { ...valid, sessionStatus: 'paused' as const };
    const unscoped = { ...valid, clinicId: '' };
    const duplicated = {
      ...valid,
      activeSlotIncludedInAhead: true,
      calledNotStartedAhead: 1,
    };
    expect(() => computeEtaUncertaintyV1(paused)).toThrow(RangeError);
    expect(() => computeEtaUncertaintyV1(unscoped)).toThrow(RangeError);
    expect(() => computeEtaUncertaintyV1(duplicated)).toThrow(RangeError);
  });
});
