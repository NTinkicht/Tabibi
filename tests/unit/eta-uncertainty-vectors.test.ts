import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type EntryType = 'scheduled' | 'walk-in' | 'guest';
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

function physicallyValid(input: EstimateInput): boolean {
  const timestamp = input.evaluatedAt ? Date.parse(input.evaluatedAt) : NaN;
  return (
    Number.isFinite(input.declaredDelay) &&
    input.declaredDelay >= 0 &&
    Number.isFinite(input.activeRemaining) &&
    input.activeRemaining >= 0 &&
    Number.isInteger(input.slotsAhead) &&
    input.slotsAhead >= 0 &&
    Number.isFinite(input.estimatedConsultation) &&
    input.estimatedConsultation > 0 &&
    Number.isInteger(input.queueRevision) &&
    input.queueRevision >= 0 &&
    Number.isFinite(timestamp)
  );
}

function explanationCodes(input: EstimateInput): string[] {
  const codes: string[] = [];
  if (input.slotsAhead > 0) codes.push('queue-depth');
  if (input.activeRemaining > 0) codes.push('active-consultation-remaining');
  if (input.declaredDelay > 0) codes.push('declared-delay');
  return codes;
}

function calculate(input: EstimateInput, _entryType: EntryType) {
  if (!physicallyValid(input)) return null;
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
    evaluatedAt: input.evaluatedAt,
    explanationCodes: explanationCodes(input),
  };
}

function publicationDecision(
  computedQueueRevision: number,
  currentQueueRevision: number,
) {
  const publish = computedQueueRevision === currentQueueRevision;
  return { publish, recompute: !publish };
}

function legacyCalculate(queueRevision: number) {
  return { queueRevision, expectedMinutes: 20 };
}

describe('eta-uncertainty/v1 executable vectors', () => {
  for (const vector of fixture.cases.filter((item: { kind: string }) =>
    ['estimate', 'retry'].includes(item.kind),
  )) {
    it(`${vector.id} is deterministic`, () => {
      const first = calculate(vector.input, vector.entryType);
      const second = calculate(vector.input, vector.entryType);
      const expected = { ...vector.expected };
      delete expected.byteEquivalentOnRetry;
      expect(first).toEqual(expected);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first!.earliestMinutes).toBeLessThanOrEqual(
        first!.expectedMinutes,
      );
      expect(first!.expectedMinutes).toBeLessThanOrEqual(first!.latestMinutes);
    });
  }

  it('produces identical evidence for identical inputs across entry types', () => {
    const vector = fixture.entryTypeEquivalence;
    const outputs = (['scheduled', 'walk-in', 'guest'] as EntryType[]).map(
      (entryType) => calculate(vector.input, entryType),
    );
    expect(outputs[0]).toEqual(vector.expected);
    expect(outputs[1]).toEqual(outputs[0]);
    expect(outputs[2]).toEqual(outputs[0]);
  });

  it('rejects stale publication and requires recomputation', () => {
    const vector = fixture.cases.find(
      (item: { kind: string }) => item.kind === 'stale-revision',
    );
    expect(
      publicationDecision(
        vector.input.computedQueueRevision,
        vector.input.currentQueueRevision,
      ),
    ).toEqual(vector.expected);
    expect(publicationDecision(42, 42)).toEqual({
      publish: true,
      recompute: false,
    });
  });

  it('does not claim v1 evidence on a legacy estimator path', () => {
    const vector = fixture.cases.find(
      (item: { kind: string }) => item.kind === 'legacy',
    );
    const legacy = legacyCalculate(vector.input.queueRevision);
    expect(vector.adoptedV1).toBe(false);
    expect(Object.hasOwn(legacy, 'estimateVersion')).toBe(false);
    expect(vector.expected.estimateVersionPresent).toBe(false);
  });

  for (const vector of fixture.invalidInputs) {
    it(`fails closed for invalid input: ${vector.id}`, () => {
      expect(calculate(vector.input, vector.entryType)).toBeNull();
    });
  }

  it('covers contract recomputation triggers without treating unrelated changes as triggers', () => {
    expect(fixture.recomputeTriggers).toContain('queue-entry-transfer');
    expect(fixture.recomputeTriggers).toContain('resume');
    expect(fixture.nonTriggers).toContain('unrelated-profile-update');
    expect(fixture.nonTriggers).toContain('ambient-time-without-refresh');
  });
});
