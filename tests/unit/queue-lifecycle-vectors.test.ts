import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type QueueState =
  | 'waiting'
  | 'checked_in'
  | 'called'
  | 'in_consultation'
  | 'completed'
  | 'cancelled'
  | 'no_show';

type QueueCommand =
  | 'check_in'
  | 'call'
  | 'no_show'
  | 'cancel'
  | 'start_consultation'
  | 'complete_consultation';

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'tests/fixtures/queue-lifecycle-v1.vectors.json'),
    'utf8',
  ),
);

const allowed: Record<QueueCommand, readonly QueueState[]> = {
  check_in: ['waiting'],
  call: ['checked_in'],
  no_show: ['checked_in', 'called'],
  cancel: ['waiting', 'checked_in', 'called'],
  start_consultation: ['called'],
  complete_consultation: ['in_consultation'],
};

const target: Record<QueueCommand, QueueState> = {
  check_in: 'checked_in',
  call: 'called',
  no_show: 'no_show',
  cancel: 'cancelled',
  start_consultation: 'in_consultation',
  complete_consultation: 'completed',
};

function transition(
  command: QueueCommand,
  state: QueueState,
): QueueState | null {
  return allowed[command].includes(state) ? target[command] : null;
}

describe('queue-lifecycle/v1 executable vectors', () => {
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
      for (const command of Object.keys(allowed) as QueueCommand[]) {
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
