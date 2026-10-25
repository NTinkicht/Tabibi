import { describe, expect, it } from 'vitest';
import {
  applyQueueCommand,
  exitsPriorityCohort,
  isTerminalQueueState,
  planPriorityExitCompaction,
  planPriorityPlacement,
  PRIORITY_COHORT_STATES,
  QUEUE_COMMANDS,
  QUEUE_ENTRY_STATES,
  type QueueCommand,
  queueCommandSessionGate,
  type QueueEntryState,
  selectNextCallableEntry,
  type ServiceOrderCandidate,
} from '@/modules/queue/lifecycle-contract';
import type { SessionStatus } from '@/modules/session';

// Full expected state x command matrix (TAB-P0-04, #672). `null` = refused.
const MATRIX: Record<
  QueueEntryState,
  Record<QueueCommand, QueueEntryState | null>
> = {
  waiting: {
    check_in: 'checked_in',
    call: null,
    no_show: null,
    cancel: 'cancelled',
    start_consultation: null,
    complete_consultation: null,
  },
  checked_in: {
    check_in: null,
    call: 'called',
    no_show: 'no_show',
    cancel: 'cancelled',
    start_consultation: null,
    complete_consultation: null,
  },
  called: {
    check_in: null,
    call: null,
    no_show: 'no_show',
    cancel: 'cancelled',
    start_consultation: 'in_consultation',
    complete_consultation: null,
  },
  in_consultation: {
    check_in: null,
    call: null,
    no_show: null,
    cancel: null,
    start_consultation: null,
    complete_consultation: 'completed',
  },
  completed: {
    check_in: null,
    call: null,
    no_show: null,
    cancel: null,
    start_consultation: null,
    complete_consultation: null,
  },
  cancelled: {
    check_in: null,
    call: null,
    no_show: null,
    cancel: null,
    start_consultation: null,
    complete_consultation: null,
  },
  no_show: {
    check_in: null,
    call: null,
    no_show: null,
    cancel: null,
    start_consultation: null,
    complete_consultation: null,
  },
};

describe('queue-lifecycle/v1 pure contract', () => {
  it('matches the full state x command matrix', () => {
    expect(QUEUE_ENTRY_STATES).toHaveLength(7);
    expect(QUEUE_COMMANDS).toHaveLength(6);
    for (const state of QUEUE_ENTRY_STATES)
      for (const command of QUEUE_COMMANDS)
        expect(applyQueueCommand(command, state), `${command} @ ${state}`).toBe(
          MATRIX[state][command],
        );
  });

  it('refuses unknown commands and states', () => {
    expect(applyQueueCommand('transfer' as QueueCommand, 'waiting')).toBeNull();
    expect(applyQueueCommand('call', 'paused' as QueueEntryState)).toBeNull();
  });

  it('marks exactly completed, cancelled and no_show as terminal', () => {
    expect(QUEUE_ENTRY_STATES.filter(isTerminalQueueState)).toEqual([
      'completed',
      'cancelled',
      'no_show',
    ]);
  });

  it('gates queue commands on the session status', () => {
    const statuses: SessionStatus[] = [
      'planned',
      'open',
      'paused',
      'closed',
      'cancelled',
    ];
    for (const status of statuses)
      for (const command of QUEUE_COMMANDS) {
        const expected =
          status === 'open'
            ? 'allowed'
            : status === 'paused'
              ? command === 'call' || command === 'start_consultation'
                ? 'session_paused'
                : 'allowed'
              : 'session_not_active';
        expect(
          queueCommandSessionGate(status, command),
          `${command} @ ${status}`,
        ).toBe(expected);
      }
    // A paused session still completes an already-active consultation.
    expect(queueCommandSessionGate('paused', 'complete_consultation')).toBe(
      'allowed',
    );
  });
});

function entry(
  id: string,
  state: QueueEntryState,
  registrationOrder: number,
  eligibilityOrder: number | null,
  priorityOrder: number | null = null,
): ServiceOrderCandidate {
  return { id, state, registrationOrder, eligibilityOrder, priorityOrder };
}

describe('queue-ordering/v1 next callable entry', () => {
  it('returns null when nobody is checked in', () => {
    expect(selectNextCallableEntry([])).toBeNull();
    expect(
      selectNextCallableEntry([
        entry('w', 'waiting', 1, null, 1),
        entry('c', 'called', 2, 1),
        entry('x', 'completed', 3, 2),
      ]),
    ).toBeNull();
  });

  it('serves priority slots before normal entries, in slot order', () => {
    const entries = [
      entry('a', 'checked_in', 1, 1),
      entry('p2', 'checked_in', 5, 4, 2),
      entry('p1', 'checked_in', 6, 5, 1),
    ];
    expect(selectNextCallableEntry(entries)?.id).toBe('p1');
    expect(selectNextCallableEntry(entries.slice(0, 2))?.id).toBe('p2');
  });

  it('never makes a waiting entry with priority call-eligible', () => {
    expect(
      selectNextCallableEntry([
        entry('w', 'waiting', 1, null, 1),
        entry('b', 'checked_in', 2, 1),
      ])?.id,
    ).toBe('b');
  });

  it('orders normal entries by check-in, so a late arrival waits its turn', () => {
    // Registered first but checked in last: served after earlier arrivals.
    const entries = [
      entry('early-reg-late-arrival', 'checked_in', 1, 3),
      entry('second', 'checked_in', 2, 1),
      entry('third', 'checked_in', 3, 2),
    ];
    expect(selectNextCallableEntry(entries)?.id).toBe('second');
  });

  it('breaks ties by immutable registration order, independent of input order', () => {
    const entries = [
      entry('later', 'checked_in', 7, 2),
      entry('earlier', 'checked_in', 3, 2),
    ];
    expect(selectNextCallableEntry(entries)?.id).toBe('earlier');
    expect(selectNextCallableEntry([...entries].reverse())?.id).toBe('earlier');
  });
});

describe('priority placement', () => {
  const cohort = ['a', 'b', 'c'];

  it('inserts a new entry at every position 1..N+1', () => {
    expect(planPriorityPlacement(cohort, 'n', 1)).toEqual({
      ok: true,
      orderedIds: ['n', 'a', 'b', 'c'],
    });
    expect(planPriorityPlacement(cohort, 'n', 2)).toEqual({
      ok: true,
      orderedIds: ['a', 'n', 'b', 'c'],
    });
    expect(planPriorityPlacement(cohort, 'n', 4)).toEqual({
      ok: true,
      orderedIds: ['a', 'b', 'c', 'n'],
    });
    expect(planPriorityPlacement([], 'n', 1)).toEqual({
      ok: true,
      orderedIds: ['n'],
    });
  });

  it('moves a cohort member to every position 1..N', () => {
    expect(planPriorityPlacement(cohort, 'c', 1)).toEqual({
      ok: true,
      orderedIds: ['c', 'a', 'b'],
    });
    expect(planPriorityPlacement(cohort, 'a', 3)).toEqual({
      ok: true,
      orderedIds: ['b', 'c', 'a'],
    });
    expect(planPriorityPlacement(cohort, 'b', 2)).toEqual({
      ok: true,
      orderedIds: ['a', 'b', 'c'],
    });
  });

  it('refuses out-of-range and non-integer positions with the maximum', () => {
    expect(planPriorityPlacement(cohort, 'n', 5)).toEqual({
      ok: false,
      maximumPosition: 4,
    });
    expect(planPriorityPlacement(cohort, 'a', 4)).toEqual({
      ok: false,
      maximumPosition: 3,
    });
    for (const position of [0, -1, 1.5, Number.NaN, Infinity])
      expect(planPriorityPlacement(cohort, 'n', position)).toEqual({
        ok: false,
        maximumPosition: 4,
      });
    expect(planPriorityPlacement([], 'n', 2)).toEqual({
      ok: false,
      maximumPosition: 1,
    });
  });

  it('never mutates the input cohort', () => {
    const input = ['a', 'b'];
    planPriorityPlacement(input, 'b', 1);
    expect(input).toEqual(['a', 'b']);
  });
});

describe('priority exit compaction', () => {
  const cohort = ['p1', 'p2', 'p3', 'p4'];

  it('holds priority slots only in waiting and checked_in', () => {
    expect([...PRIORITY_COHORT_STATES]).toEqual(['waiting', 'checked_in']);
  });

  it('classifies every legal transition of the matrix as cohort exit or not', () => {
    for (const state of QUEUE_ENTRY_STATES)
      for (const command of QUEUE_COMMANDS) {
        const target = MATRIX[state][command];
        if (target === null) continue;
        const expected =
          (state === 'waiting' || state === 'checked_in') &&
          target !== 'waiting' &&
          target !== 'checked_in';
        expect(exitsPriorityCohort(state, target), `${state}/${command}`).toBe(
          expected,
        );
      }
  });

  it('keeps check-in inside the cohort and exits on call, cancel and no-show', () => {
    expect(exitsPriorityCohort('waiting', 'checked_in')).toBe(false);
    expect(exitsPriorityCohort('checked_in', 'called')).toBe(true);
    expect(exitsPriorityCohort('waiting', 'cancelled')).toBe(true);
    expect(exitsPriorityCohort('checked_in', 'no_show')).toBe(true);
    expect(exitsPriorityCohort('called', 'in_consultation')).toBe(false);
  });

  it.each([
    [['p1'], ['p2', 'p3', 'p4']],
    [['p3'], ['p1', 'p2', 'p4']],
    [['p4'], ['p1', 'p2', 'p3']],
    [['p1', 'p3'], ['p2', 'p4']],
    [cohort, []],
    [['unknown'], cohort],
    [[], cohort],
  ])('removes %j and keeps the rest in slot order (new slot = index + 1)', (exiting, expected) => {
    const remaining = planPriorityExitCompaction(cohort, exiting);
    expect(remaining).toEqual(expected);
  });

  it('never mutates the input cohort', () => {
    const input = Object.freeze([...cohort]);
    planPriorityExitCompaction(input, ['p2']);
    expect(input).toEqual(cohort);
  });
});
