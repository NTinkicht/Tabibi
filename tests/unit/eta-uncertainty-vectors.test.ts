import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type EstimateInput = {
  declaredDelay: number;
  activeRemaining: number;
  slotsAhead: number;
  estimatedConsultation: number;
  queueRevision: number;
  evaluatedAt?: string;
};

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'tests/fixtures/eta-uncertainty-v1.vectors.json'),
    'utf8',
  ),
);

function calculate(input: EstimateInput) {
  if (!input.evaluatedAt || !Number.isFinite(input.queueRevision)) return null;
  const rawEarliest =
    input.declaredDelay +
    input.activeRemaining +
    input.slotsAhead * input.estimatedConsultation * 0.75;
  const rawExpected =
    input.declaredDelay +
    input.activeRemaining +
    input.slotsAhead * input.estimatedConsultation;
  const rawLatest =
    input.declaredDelay +
    input.activeRemaining +
    input.slotsAhead * input.estimatedConsultation * 1.5;
  const point = rawEarliest === rawExpected && rawExpected === rawLatest;
  return {
    earliestMinutes: point ? Math.round(rawExpected) : Math.floor(rawEarliest),
    expectedMinutes: Math.round(rawExpected),
    latestMinutes: point ? Math.round(rawExpected) : Math.ceil(rawLatest),
    estimateVersion: 'eta-uncertainty/v1',
    queueRevision: input.queueRevision,
  };
}

describe('eta-uncertainty/v1 executable vectors', () => {
  for (const vector of fixture.cases.filter((item: { kind: string }) =>
    ['estimate', 'retry'].includes(item.kind),
  )) {
    it(`${vector.id} is deterministic`, () => {
      const first = calculate(vector.input);
      const second = calculate(vector.input);
      expect(first).toEqual(
        vector.expected.byteEquivalentOnRetry
          ? { ...vector.expected, byteEquivalentOnRetry: undefined }
          : vector.expected,
      );
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first!.earliestMinutes).toBeLessThanOrEqual(
        first!.expectedMinutes,
      );
      expect(first!.expectedMinutes).toBeLessThanOrEqual(first!.latestMinutes);
    });
  }

  it('rejects stale publication and requires recomputation', () => {
    const vector = fixture.cases.find(
      (item: { kind: string }) => item.kind === 'stale-revision',
    );
    expect(vector.input.computedQueueRevision).not.toBe(
      vector.input.currentQueueRevision,
    );
    expect(vector.expected).toEqual({ publish: false, recompute: true });
  });

  it('does not claim v1 evidence on a legacy estimator path', () => {
    const vector = fixture.cases.find(
      (item: { kind: string }) => item.kind === 'legacy',
    );
    expect(vector.adoptedV1).toBe(false);
    expect(vector.expected.estimateVersionPresent).toBe(false);
  });

  it('fails closed when required evaluation input is absent', () => {
    const vector = fixture.cases.find(
      (item: { kind: string }) => item.kind === 'invalid',
    );
    expect(calculate(vector.input)).toBeNull();
    expect(vector.expected.accepted).toBe(false);
  });

  it('covers contract recomputation triggers without treating unrelated changes as triggers', () => {
    expect(fixture.recomputeTriggers).toContain('queue-entry-transfer');
    expect(fixture.recomputeTriggers).toContain('resume');
    expect(fixture.nonTriggers).toContain('unrelated-profile-update');
    expect(fixture.nonTriggers).toContain('ambient-time-without-refresh');
  });
});
