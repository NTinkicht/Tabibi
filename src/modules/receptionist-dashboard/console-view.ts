import {
  QUEUE_COMMAND_SOURCE_STATES,
  orderQueueForDisplay,
  queueCommandSessionGate,
  selectNextCallableEntry,
  type QueueCommand,
  type QueueEntryState,
} from '@/modules/queue/lifecycle-contract';
import type { SessionStatus } from '@/modules/session';

/**
 * Pure view-model for the reception console (docs/design/reception-console.md).
 * It only arranges server-committed dashboard data and derives which existing
 * commands a control may offer; it never computes an ETA, a clock time or an
 * ordering of its own beyond the queue-ordering/v1 display contract.
 */
export interface ConsoleEntry {
  id: string;
  state: QueueEntryState;
  registrationOrder: number;
  eligibilityOrder: number | null;
  priorityOrder: number | null;
  publicDisplayLabel: string;
  privateDisplayName: string;
  preferredLocale: 'ar' | 'fr';
  hasContact: boolean;
  origin: 'appointment' | 'walk_in';
  appointmentStartsAt: string | null;
  activeConsultationRemainingMinutes: number | null;
  eta: { minWaitMinutes: number; maxWaitMinutes: number } | null;
}

export interface ConsoleRowActions {
  /** The single primary command of the row, or null when none applies. */
  primary: QueueCommand | null;
  primaryDisabled: boolean;
  /** Commands offered in the reason-gated panel. */
  panel: ReadonlyArray<'prioritise' | 'no_show' | 'cancel'>;
}

export interface ConsoleRow {
  entry: ConsoleEntry;
  /** 1-based position within the queue list; null for serving cards. */
  position: number | null;
  isNext: boolean;
  isPriority: boolean;
  actions: ConsoleRowActions;
}

export interface ConsoleView {
  serving: ConsoleRow[];
  queue: ConsoleRow[];
  nextCallable: ConsoleEntry | null;
  callNextEnabled: boolean;
  paused: boolean;
  arrivedCount: number;
  notArrivedCount: number;
}

function sourceAllows(command: QueueCommand, state: QueueEntryState): boolean {
  return QUEUE_COMMAND_SOURCE_STATES[command].includes(state);
}

function commandAllowed(status: SessionStatus, command: QueueCommand): boolean {
  return queueCommandSessionGate(status, command) === 'allowed';
}

function rowActions(
  entry: ConsoleEntry,
  status: SessionStatus,
): ConsoleRowActions {
  const panel: Array<'prioritise' | 'no_show' | 'cancel'> = [];
  if (
    (entry.state === 'waiting' || entry.state === 'checked_in') &&
    entry.priorityOrder === null
  )
    panel.push('prioritise');
  if (sourceAllows('no_show', entry.state)) panel.push('no_show');
  if (sourceAllows('cancel', entry.state)) panel.push('cancel');
  let primary: QueueCommand | null = null;
  if (sourceAllows('check_in', entry.state)) primary = 'check_in';
  else if (sourceAllows('call', entry.state)) primary = 'call';
  else if (sourceAllows('start_consultation', entry.state))
    primary = 'start_consultation';
  else if (sourceAllows('complete_consultation', entry.state))
    primary = 'complete_consultation';
  return {
    primary,
    primaryDisabled: primary === null || !commandAllowed(status, primary),
    panel,
  };
}

export function buildConsoleView(
  entries: readonly ConsoleEntry[],
  status: SessionStatus,
): ConsoleView {
  const ordered = orderQueueForDisplay(entries);
  const nextCallable = selectNextCallableEntry(entries) as ConsoleEntry | null;
  const toRow = (entry: ConsoleEntry, position: number | null): ConsoleRow => ({
    entry,
    position,
    isNext: nextCallable !== null && nextCallable.id === entry.id,
    isPriority: entry.priorityOrder !== null,
    actions: rowActions(entry, status),
  });
  const serving = ordered
    .filter((e) => e.state === 'in_consultation' || e.state === 'called')
    .sort(
      (a, b) =>
        Number(b.state === 'in_consultation') -
        Number(a.state === 'in_consultation'),
    )
    .map((e) => toRow(e, null));
  const queue = ordered
    .filter((e) => e.state === 'checked_in' || e.state === 'waiting')
    .map((e, index) => toRow(e, index + 1));
  return {
    serving,
    queue,
    nextCallable,
    callNextEnabled: nextCallable !== null && commandAllowed(status, 'call'),
    paused: status === 'paused',
    arrivedCount: queue.filter((r) => r.entry.state === 'checked_in').length,
    notArrivedCount: queue.filter((r) => r.entry.state === 'waiting').length,
  };
}

/** Canonical server ETA range as text; never a clock time. */
export function formatWaitRange(
  eta: ConsoleEntry['eta'],
  copy: { waitRange: string; waitSingle: string; waitUnknown: string },
): string {
  if (eta === null || eta === undefined) return copy.waitUnknown;
  if (eta.minWaitMinutes === eta.maxWaitMinutes)
    return copy.waitSingle.replace('{min}', String(eta.minWaitMinutes));
  return copy.waitRange
    .replace('{min}', String(eta.minWaitMinutes))
    .replace('{max}', String(eta.maxWaitMinutes));
}

/** Delay control: committed value stepped by 5 minutes, clamped to 0..720. */
export const CONSOLE_DELAY_STEP_MINUTES = 5;
export const CONSOLE_DELAY_MAX_MINUTES = 720;
export function steppedDelay(
  committed: number | null,
  direction: 1 | -1,
): number {
  const base = committed ?? 0;
  const next = base + direction * CONSOLE_DELAY_STEP_MINUTES;
  return Math.min(CONSOLE_DELAY_MAX_MINUTES, Math.max(0, next));
}

/** Status-bar text for a committed command, from the FR/AR `lastAction` copy. */
export function formatLastAction(
  template: string,
  entry: Pick<ConsoleEntry, 'publicDisplayLabel' | 'privateDisplayName'>,
  stateLabel: string,
): string {
  return template
    .replace('{ticket}', entry.publicDisplayLabel)
    .replace('{name}', entry.privateDisplayName)
    .replace('{state}', stateLabel);
}
