import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeEtaUncertaintyV1,
  mayPublishEtaUncertaintyV1,
  type EtaUncertaintyInput,
} from '@/modules/queue-eta-estimator/uncertainty-v1';

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'tests/fixtures/eta-uncertainty-v1.vectors.json'),
    'utf8',
  ),
);
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

describe('WU #606 production eta-uncertainty/v1 estimator', () => {
  for (const vector of fixture.cases.filter(
    (item: { kind: string }) => ['estimate', 'retry'].includes(item.kind),
  )) {
    it(`${vector.id}: matches the committed acceptance vector`, () => {
      const input = adapt(vector.input);
      const first = computeEtaUncertaintyV1(input);
      const second = computeEtaUncertaintyV1({ ...input });
      const expected = { ...vector.expected };
      delete expected.byteEquivalentOnRetry;
      delete expected.explanationCodes;
      expect(first).toMatchObject(expected);
      expect(first.explanationCodes).toEqual([
        ...vector.expected.explanationCodes,
        'fallback',
      ]);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.explanationCodes)).toBe(true);
    });
  }

  it('never collapses real uncertainty after rounding', () => {
    const result = computeEtaUncertaintyV1(
      adapt({
        declaredDelay: 0.8,
        activeRemaining: 0,
        slotsAhead: 1,
        estimatedConsultation: 1,
        queueRevision: 7,
        evaluatedAt: '2026-10-04T10:05:00Z',
      }),
    );
    expect([
      result.earliestMinutes,
      result.expectedMinutes,
      result.latestMinutes,
    ]).toEqual([1, 2, 3]);
  });

  it(
    'counts called service work once and replaces an active slot with remaining time',
    () => {
      const input = adapt({
        declaredDelay: 0,
        activeRemaining: 0,
        slotsAhead: 2,
        estimatedConsultation: 10,
        queueRevision: 41,
        evaluatedAt: '2026-10-04T10:00:00Z',
      },
  );
    const called = computeEtaUncertaintyV1({
      ...input,
      calledNotStartedAhead: 1,
    });
    const active = computeEtaUncertaintyV1({
      ...input,
      activeSlotIncludedInAhead: true,
      activeConsultationRemainingMinutes: 4,
    });
    expect(called.expectedMinutes).toBe(20);
    expect(called.explanationCodes).toContain('called-not-started');
    expect(active.expectedMinutes).toBe(14);
    expect(active.explanationCodes).toContain('active-consultation-remaining');
  });

  it(
    'rejects stale CAS publication and accepts exact committed revision',
    () => {
      const estimate = computeEtaUncertaintyV1(
        adapt({
          declaredDelay: 0,
          activeRemaining: 0,
          slotsAhead: 1,
          estimatedConsultation: 10,
          queueRevision: 41,
          evaluatedAt: '2026-10-04T10:00:00Z',
        }),
      );
      expect(mayPublishEtaUncertaintyV1(estimate, 42)).toBe(false);
      expect(mayPublishEtaUncertaintyV1(estimate, 41)).toBe(true);
    },
  );

  it('fails closed for every invalid committed-input vector', () => {
    for (const vector of fixture.invalidInputs) {
      expect(() => computeEtaUncertaintyV1(adapt(vector.input))).toThrow(
        RangeError,
      );
    }
  });

  it(
    'rejects paused sessions, missing scope, and contradictory active/called counts',
    () => {
      const input = adapt({
        declaredDelay: 0,
        activeRemaining: 0,
        slotsAhead: 1,
        estimatedConsultation: 10,
        queueRevision: 41,
        evaluatedAt: '2026-10-04T10:00:00Z',
      },
  );
    expect(() =>
      computeEtaUncertaintyV1({ ...input, sessionStatus: 'paused' }),
    ).toThrow();
    expect(() =>
      computeEtaUncertaintyV1({ ...input, clinicId: '' }),
    ).toThrow();
    expect(() =>
      computeEtaUncertaintyV1({
        ...input,
        activeSlotIncludedInAhead: true,
        calledNotStartedAhead: 1,
      }),
    ).toThrow();
  });
});
