import type { SessionStatus } from '@/modules/session';

/**
 * Pure canonical queue-entry lifecycle contract (TAB-P0-04, #672).
 *
 * Transactional services consume these functions; they never re-declare the
 * state x command table, the session gate, the service order or the priority
 * placement rule. Everything here is deterministic and database-free.
 */
export const QUEUE_LIFECYCLE_CONTRACT_VERSION = 'queue-lifecycle/v1' as const;

export type QueueEntryState =
  | 'waiting'
  | 'checked_in'
  | 'called'
  | 'in_consultation'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export type QueueCommand =
  | 'check_in'
  | 'call'
  | 'no_show'
  | 'cancel'
  | 'start_consultation'
  | 'complete_consultation';

export const QUEUE_ENTRY_STATES: readonly QueueEntryState[] = [
  'waiting',
  'checked_in',
  'called',
  'in_consultation',
  'completed',
  'cancelled',
  'no_show',
];

export const QUEUE_COMMANDS: readonly QueueCommand[] = [
  'check_in',
  'call',
  'no_show',
  'cancel',
  'start_consultation',
  'complete_consultation',
];

export const QUEUE_COMMAND_SOURCE_STATES: Readonly<
  Record<QueueCommand, readonly QueueEntryState[]>
> = {
  check_in: ['waiting'],
  call: ['checked_in'],
  no_show: ['checked_in', 'called'],
  cancel: ['waiting', 'checked_in', 'called'],
  start_consultation: ['called'],
  complete_consultation: ['in_consultation'],
};

export const QUEUE_COMMAND_TARGET_STATE: Readonly<
  Record<QueueCommand, QueueEntryState>
> = {
  check_in: 'checked_in',
  call: 'called',
  no_show: 'no_show',
  cancel: 'cancelled',
  start_consultation: 'in_consultation',
  complete_consultation: 'completed',
};

const TERMINAL_STATES: readonly QueueEntryState[] = [
  'completed',
  'cancelled',
  'no_show',
];

export function isTerminalQueueState(state: QueueEntryState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** The target state, or `null` when the command is illegal from `state`. */
export function applyQueueCommand(
  command: QueueCommand,
  state: QueueEntryState,
): QueueEntryState | null {
  const sources = QUEUE_COMMAND_SOURCE_STATES[command];
  if (!sources || !sources.includes(state)) return null;
  return QUEUE_COMMAND_TARGET_STATE[command];
}

export type QueueCommandSessionGate =
  | 'allowed'
  | 'session_not_active'
  | 'session_paused';

/**
 * Queue commands need an open or paused session. A paused session still lets
 * reception check in and resolve entries (and complete an already-active
 * consultation) but refuses `call` and `start_consultation` until resume.
 */
export function queueCommandSessionGate(
  status: SessionStatus,
  command: QueueCommand,
): QueueCommandSessionGate {
  if (status !== 'open' && status !== 'paused') return 'session_not_active';
  if (
    status === 'paused' &&
    (command === 'call' || command === 'start_consultation')
  )
    return 'session_paused';
  return 'allowed';
}

export interface ServiceOrderCandidate {
  id: string;
  state: QueueEntryState;
  priorityOrder: number | null;
  eligibilityOrder: number | null;
  registrationOrder: number;
}

/**
 * The committed service order (`queue-ordering/v1`): only `checked_in` entries
 * are callable (a waiting entry may hold a priority slot but is never
 * callable); priority slots come first in slot order, then eligibility order
 * (check-in order), then immutable registration order.
 */
export function selectNextCallableEntry(
  entries: readonly ServiceOrderCandidate[],
): ServiceOrderCandidate | null {
  let best: ServiceOrderCandidate | null = null;
  for (const entry of entries) {
    if (entry.state !== 'checked_in') continue;
    if (best === null || compareServiceOrder(entry, best) < 0) best = entry;
  }
  return best;
}

function compareServiceOrder(
  a: ServiceOrderCandidate,
  b: ServiceOrderCandidate,
): number {
  if ((a.priorityOrder === null) !== (b.priorityOrder === null))
    return a.priorityOrder === null ? 1 : -1;
  if (a.priorityOrder !== null && b.priorityOrder !== null)
    if (a.priorityOrder !== b.priorityOrder)
      return a.priorityOrder - b.priorityOrder;
  if ((a.eligibilityOrder === null) !== (b.eligibilityOrder === null))
    return a.eligibilityOrder === null ? 1 : -1;
  if (a.eligibilityOrder !== null && b.eligibilityOrder !== null)
    if (a.eligibilityOrder !== b.eligibilityOrder)
      return a.eligibilityOrder - b.eligibilityOrder;
  return a.registrationOrder - b.registrationOrder;
}

export type PriorityPlacement =
  | { ok: true; orderedIds: string[] }
  | { ok: false; maximumPosition: number };

/**
 * One-based priority placement over the current contiguous priority cohort
 * (ids in slot order). A new entry may be inserted at 1..N+1; an entry already
 * in the cohort may be moved to 1..N. Anything else is refused with the
 * allowed maximum. The result is the new contiguous slot order (slot = index+1).
 */
export function planPriorityPlacement(
  cohortIds: readonly string[],
  entryId: string,
  targetPosition: number,
): PriorityPlacement {
  const sourceIndex = cohortIds.indexOf(entryId);
  const maximumPosition =
    sourceIndex < 0 ? cohortIds.length + 1 : cohortIds.length;
  if (
    !Number.isSafeInteger(targetPosition) ||
    targetPosition < 1 ||
    targetPosition > maximumPosition
  )
    return { ok: false, maximumPosition };
  const orderedIds = cohortIds.filter((id) => id !== entryId);
  orderedIds.splice(targetPosition - 1, 0, entryId);
  return { ok: true, orderedIds };
}
