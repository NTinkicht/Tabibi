import { describe, expect, it } from 'vitest';
import {
  isTerminalQueueState,
  orderQueueForDisplay,
  QUEUE_DISPLAY_STATE_RANK,
  QUEUE_ENTRY_STATES,
  type QueueEntryState,
  selectNextCallableEntry,
  type ServiceOrderCandidate,
} from '@/modules/queue/lifecycle-contract';

// Displayed service order of active queue entries (TAB-P0-04, #684).

function entry(
  id: string,
  state: QueueEntryState,
  registrationOrder: number,
  eligibilityOrder: number | null,
  priorityOrder: number | null = null,
): ServiceOrderCandidate {
  return { id, state, registrationOrder, eligibilityOrder, priorityOrder };
}

function ids(entries: readonly ServiceOrderCandidate[]): string[] {
  return entries.map((candidate) => candidate.id);
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest],
    ),
  );
}

describe('queue display order contract', () => {
  it('ranks served, then callable, then waiting, and no terminal state', () => {
    expect(QUEUE_DISPLAY_STATE_RANK).toEqual({
      called: 0,
      in_consultation: 0,
      checked_in: 1,
      waiting: 2,
    });
    for (const state of QUEUE_ENTRY_STATES)
      expect(QUEUE_DISPLAY_STATE_RANK[state] === undefined).toBe(
        isTerminalQueueState(state),
      );
  });

  it('orders by state rank before any priority slot', () => {
    const ordered = orderQueueForDisplay([
      entry('waiting-priority', 'waiting', 1, null, 1),
      entry('checked', 'checked_in', 2, 1),
      entry('in-consultation', 'in_consultation', 3, 2),
      entry('called', 'called', 4, 3),
    ]);
    expect(ids(ordered)).toEqual([
      'in-consultation',
      'called',
      'checked',
      'waiting-priority',
    ]);
  });

  it('keeps a waiting entry with a priority slot after every checked_in entry', () => {
    const ordered = orderQueueForDisplay([
      entry('w-p1', 'waiting', 1, null, 1),
      entry('c-normal-late', 'checked_in', 2, 9),
      entry('c-p2', 'checked_in', 3, 2, 2),
      entry('w-normal', 'waiting', 4, null),
    ]);
    expect(ids(ordered)).toEqual(['c-p2', 'c-normal-late', 'w-p1', 'w-normal']);
  });

  it('serves priority slots in slot order before normal checked_in entries', () => {
    const ordered = orderQueueForDisplay([
      entry('normal', 'checked_in', 1, 1),
      entry('p2', 'checked_in', 2, 3, 2),
      entry('p1', 'checked_in', 3, 2, 1),
    ]);
    expect(ids(ordered)).toEqual(['p1', 'p2', 'normal']);
  });

  it('orders late arrivals by eligibility (check-in) order, not registration', () => {
    const ordered = orderQueueForDisplay([
      entry('registered-first-arrived-late', 'checked_in', 1, 3),
      entry('registered-second', 'checked_in', 2, 1),
      entry('registered-third', 'checked_in', 3, 2),
    ]);
    expect(ids(ordered)).toEqual([
      'registered-second',
      'registered-third',
      'registered-first-arrived-late',
    ]);
  });

  it('orders waiting entries by registration order', () => {
    const ordered = orderQueueForDisplay([
      entry('w3', 'waiting', 3, null),
      entry('w1', 'waiting', 1, null),
      entry('w2', 'waiting', 2, null),
    ]);
    expect(ids(ordered)).toEqual(['w1', 'w2', 'w3']);
  });

  it('drops terminal entries', () => {
    const ordered = orderQueueForDisplay([
      entry('done', 'completed', 1, 1),
      entry('cancelled', 'cancelled', 2, null),
      entry('no-show', 'no_show', 3, 2),
      entry('active', 'checked_in', 4, 3),
    ]);
    expect(ids(ordered)).toEqual(['active']);
    expect(orderQueueForDisplay([])).toEqual([]);
  });

  it('does not mutate its input and returns the same entry objects', () => {
    const input = [
      entry('b', 'waiting', 2, null),
      entry('a', 'checked_in', 1, 1),
    ];
    const snapshot = structuredClone(input);
    const ordered = orderQueueForDisplay(input);
    expect(input).toEqual(snapshot);
    expect(ordered[0]).toBe(input[1]);
    expect(ordered).not.toBe(input);
  });

  const vector = [
    entry('called', 'called', 2, 1),
    entry('c-p1', 'checked_in', 6, 5, 1),
    entry('c-p2', 'checked_in', 4, 3, 2),
    entry('c-late', 'checked_in', 1, 4),
    entry('c-early', 'checked_in', 3, 2),
    entry('w-p3', 'waiting', 5, null, 3),
    entry('done', 'completed', 7, 6),
  ];
  const expected = ['called', 'c-p1', 'c-p2', 'c-early', 'c-late', 'w-p3'];

  it('is independent of input order', () => {
    for (const permutation of permutations(vector))
      expect(ids(orderQueueForDisplay(permutation))).toEqual(expected);
  });

  it('puts selectNextCallableEntry first among the displayed checked_in entries', () => {
    for (const permutation of permutations(vector)) {
      const firstCallable = orderQueueForDisplay(permutation).find(
        (candidate) => candidate.state === 'checked_in',
      );
      expect(firstCallable).toBe(selectNextCallableEntry(permutation));
    }
    const noneCallable = [
      entry('w', 'waiting', 1, null, 1),
      entry('c', 'called', 2, 1),
    ];
    expect(
      orderQueueForDisplay(noneCallable).find(
        (candidate) => candidate.state === 'checked_in',
      ),
    ).toBeUndefined();
    expect(selectNextCallableEntry(noneCallable)).toBeNull();
  });
});
