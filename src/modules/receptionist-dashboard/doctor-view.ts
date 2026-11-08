import {
  QUEUE_COMMAND_SOURCE_STATES,
  queueCommandSessionGate,
  type QueueCommand,
} from '@/modules/queue/lifecycle-contract';
import type { SessionStatus } from '@/modules/session';
import { buildConsoleView, type ConsoleEntry } from './console-view';

/**
 * Pure view-model for the doctor phone view (docs/design/doctor-view.md).
 * It only chooses which ONE existing command the primary button maps to and
 * arranges server-committed data; it never computes an ETA or an ordering of
 * its own. Authorization is enforced server-side (owner decision #799).
 */
export type DoctorPrimaryCommand =
  | 'complete_consultation'
  | 'start_consultation'
  | 'call';

export const DOCTOR_NEXT_LIST_LIMIT = 4;

export interface DoctorView {
  /** The in-consultation entry, else the called entry, else null. */
  current: ConsoleEntry | null;
  primary: {
    command: DoctorPrimaryCommand;
    /** Entry the command is issued on (current, or the next callable). */
    entry: ConsoleEntry;
    disabled: boolean;
  } | null;
  /** No-show is offered only for a called patient, when the gate allows it. */
  canNoShow: boolean;
  paused: boolean;
  /** Up to four next arrived entries after the one the primary would call. */
  next: ConsoleEntry[];
  notArrivedCount: number;
  completedCount: number;
  noShowCount: number;
}

function allowed(status: SessionStatus, command: QueueCommand): boolean {
  return queueCommandSessionGate(status, command) === 'allowed';
}

export function buildDoctorView(
  entries: readonly ConsoleEntry[],
  status: SessionStatus,
): DoctorView {
  const view = buildConsoleView(entries, status);
  const current = view.serving[0]?.entry ?? null;
  let primary: DoctorView['primary'] = null;
  if (
    current &&
    QUEUE_COMMAND_SOURCE_STATES.complete_consultation.includes(current.state)
  )
    primary = {
      command: 'complete_consultation',
      entry: current,
      disabled: !allowed(status, 'complete_consultation'),
    };
  else if (current)
    primary = {
      command: 'start_consultation',
      entry: current,
      disabled: !allowed(status, 'start_consultation'),
    };
  else if (view.nextCallable)
    primary = {
      command: 'call',
      entry: view.nextCallable,
      disabled: !allowed(status, 'call'),
    };
  const arrived = view.queue
    .filter((row) => row.entry.state === 'checked_in')
    .map((row) => row.entry);
  return {
    current,
    primary,
    canNoShow:
      current !== null &&
      current.state === 'called' &&
      QUEUE_COMMAND_SOURCE_STATES.no_show.includes(current.state) &&
      allowed(status, 'no_show'),
    paused: view.paused,
    next: arrived
      .filter((entry) => entry.id !== view.nextCallable?.id || current !== null)
      .slice(0, DOCTOR_NEXT_LIST_LIMIT),
    notArrivedCount: view.notArrivedCount,
    completedCount: entries.filter((e) => e.state === 'completed').length,
    noShowCount: entries.filter((e) => e.state === 'no_show').length,
  };
}
