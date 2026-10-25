import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyQueueCommand,
  QUEUE_COMMANDS,
  QUEUE_LIFECYCLE_CONTRACT_VERSION,
} from '@/modules/queue/lifecycle-contract';

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'tests/fixtures/queue-lifecycle-v1.vectors.json'),
    'utf8',
  ),
);

// The fixture runs against the production contract, not a test-local copy.
const transition = applyQueueCommand;

describe('queue-lifecycle/v1 executable vectors', () => {
  it('is the fixture of the production contract version', () => {
    expect(fixture.contractVersion).toBe(QUEUE_LIFECYCLE_CONTRACT_VERSION);
  });

  it('executes every canonical positive transition', () => {
    for (const vector of fixture.transitions) {
      expect(transition(vector.command, vector.from)).toBe(vector.to);
    }
  });

  it('fails closed for stale, terminal, and impossible transitions', () => {
    for (const vector of fixture.invalidTransitions) {
      expect(transition(vector.command, vector.from)).toBeNull();
    }
  });

  it('keeps terminal outcomes terminal', () => {
    for (const state of fixture.terminalStates) {
      for (const command of QUEUE_COMMANDS) {
        expect(transition(command, state)).toBeNull();
      }
    }
  });

  it('distinguishes exact idempotent replay from conflicting key reuse', () => {
    const exact = fixture.idempotency.find(
      (item: { id: string }) => item.id === 'exact-replay',
    );
    const conflict = fixture.idempotency.find(
      (item: { id: string }) => item.id === 'changed-payload-reuse',
    );

    expect(exact).toMatchObject({
      sameKey: true,
      samePayload: true,
      expected: 'stored_receipt',
      secondLifecycleEvent: false,
    });
    expect(conflict).toMatchObject({
      sameKey: true,
      samePayload: false,
      expected: 'conflict',
      secondLifecycleEvent: false,
    });
  });
});
