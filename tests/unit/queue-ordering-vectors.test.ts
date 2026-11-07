import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  QUEUE_ORDERING_CONTRACT_VERSION,
  QueueOrderingError,
  isCallEligible,
  orderCallableEntries,
  type QueueOrderingEntry,
  type QueueOrderingEntryState,
  type QueueOrderingSessionStatus,
} from '@/modules/queue/ordering-contract';

interface Vector {
  caseId: string;
  contractVersion: string;
  rule: string;
  sessionStatus: QueueOrderingSessionStatus;
  entries: QueueOrderingEntry[];
  outcome: 'accepted' | 'rejected';
  expectedOrderedEntryIds: string[];
  rejectionReason: string | null;
}

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'tests/fixtures/queue-ordering-v1.vectors.json'),
    'utf8',
  ),
) as { contractVersion: string; cases: Vector[] };

describe('queue-ordering/v1 executable vectors', () => {
  it('is the fixture of the production contract version', () => {
    expect(fixture.contractVersion).toBe(QUEUE_ORDERING_CONTRACT_VERSION);
    expect(fixture.cases.length).toBeGreaterThan(20);
    const ids = fixture.cases.map((item) => item.caseId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const vector of fixture.cases) {
    it(`${vector.caseId}: ${vector.rule}`, () => {
      const run = () =>
        orderCallableEntries(
          vector.contractVersion,
          vector.sessionStatus,
          vector.entries,
        );
      if (vector.outcome === 'accepted') {
        expect(vector.rejectionReason).toBeNull();
        expect(run()).toEqual(vector.expectedOrderedEntryIds);
        expect(run()).toEqual(run());
        expect(
          orderCallableEntries(
            vector.contractVersion,
            vector.sessionStatus,
            [...vector.entries].reverse(),
          ),
        ).toEqual(vector.expectedOrderedEntryIds);
      } else {
        expect(vector.expectedOrderedEntryIds).toEqual([]);
        expect(vector.rejectionReason).toBeTruthy();
        try {
          run();
          expect.unreachable('vector must be rejected');
        } catch (error) {
          expect(error).toBeInstanceOf(QueueOrderingError);
          expect((error as QueueOrderingError).reason).toBe(
            vector.rejectionReason,
          );
        }
      }
    });
  }

  it('is call-eligible only for checked_in entries in an open session', () => {
    const states: QueueOrderingEntryState[] = [
      'waiting',
      'checked_in',
      'called',
      'in_consultation',
      'completed',
      'cancelled',
      'no_show',
    ];
    const sessions: QueueOrderingSessionStatus[] = [
      'planned',
      'open',
      'paused',
      'closed',
      'cancelled',
    ];
    for (const session of sessions) {
      for (const state of states) {
        expect(isCallEligible(session, state)).toBe(
          session === 'open' && state === 'checked_in',
        );
      }
    }
  });
});
