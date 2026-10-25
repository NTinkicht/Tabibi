/**
 * Pure ConsultationSession lifecycle contract (TAB-P0-04).
 *
 * The transactional SessionService consumes these functions; nothing here
 * touches the database, clocks or randomness. Changing any table below is a
 * behaviour change and must bump SESSION_LIFECYCLE_CONTRACT_VERSION.
 */

export const SESSION_LIFECYCLE_CONTRACT_VERSION = 'session-lifecycle/v4';

export const SESSION_STATUSES = [
  'planned',
  'open',
  'paused',
  'closed',
  'cancelled',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_COMMANDS = [
  'open',
  'pause',
  'resume',
  'close',
  'cancel',
] as const;
export type SessionCommand = (typeof SESSION_COMMANDS)[number];

export const DELAY_COMMANDS = [
  'declare_delay',
  'update_delay',
  'clear_delay',
] as const;
export type DelayCommand = (typeof DELAY_COMMANDS)[number];

export const MAX_DELAY_MINUTES = 720;

export const SESSION_TRANSITIONS: Readonly<
  Record<SessionStatus, readonly SessionStatus[]>
> = {
  planned: ['open', 'cancelled'],
  open: ['paused', 'closed', 'cancelled'],
  paused: ['open', 'closed', 'cancelled'],
  closed: [],
  cancelled: [],
};

export const SESSION_COMMAND_TARGET: Readonly<
  Record<SessionCommand, SessionStatus>
> = {
  open: 'open',
  pause: 'paused',
  resume: 'open',
  close: 'closed',
  cancel: 'cancelled',
};

/**
 * Statuses each command may be issued from. Two commands target `open`, so
 * the target alone cannot tell them apart: `open` starts a planned session
 * and `resume` restarts a paused one; neither stands in for the other.
 */
export const SESSION_COMMAND_SOURCES: Readonly<
  Record<SessionCommand, readonly SessionStatus[]>
> = {
  open: ['planned'],
  pause: ['open'],
  resume: ['paused'],
  close: ['open', 'paused'],
  cancel: ['planned', 'open', 'paused'],
};

/** Queue-entry states cancelled together with their session. */
export const SESSION_CANCELLATION_CASCADE_QUEUE_STATES = [
  'waiting',
  'checked_in',
  'called',
] as const;

/**
 * Queue-entry states that block whole-session cancellation (TAB-P0-05:
 * "cancellation rejects active consultation"). v2 added this precondition.
 */
export const SESSION_CANCELLATION_BLOCKING_QUEUE_STATES = [
  'in_consultation',
] as const;

/** True when any of the session's queue-entry states blocks cancellation. */
export function sessionCancellationBlockedBy(
  queueStates: readonly string[],
): boolean {
  return queueStates.some((state) =>
    (SESSION_CANCELLATION_BLOCKING_QUEUE_STATES as readonly string[]).includes(
      state,
    ),
  );
}

/**
 * Queue-entry states that block closing a session: every non-terminal entry
 * must be resolved first (served, cancelled, or no-show via the TAB-P0-07
 * close-time resolution). Mirrors the database guard
 * enforce_session_queue_terminal_transition(). v4 added this precondition.
 */
export const SESSION_CLOSE_BLOCKING_QUEUE_STATES = [
  'waiting',
  'checked_in',
  'called',
  'in_consultation',
] as const;

/** True when any of the session's queue-entry states blocks closing. */
export function sessionCloseBlockedBy(queueStates: readonly string[]): boolean {
  return queueStates.some((state) =>
    (SESSION_CLOSE_BLOCKING_QUEUE_STATES as readonly string[]).includes(state),
  );
}

export function canTransitionSession(
  from: SessionStatus,
  to: SessionStatus,
): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return SESSION_TRANSITIONS[status].length === 0;
}

/** Target status of `command` from `from`, or null when not allowed. */
export function applySessionCommand(
  command: SessionCommand,
  from: SessionStatus,
): SessionStatus | null {
  const target = SESSION_COMMAND_TARGET[command];
  return SESSION_COMMAND_SOURCES[command].includes(from) &&
    canTransitionSession(from, target)
    ? target
    : null;
}

export function sessionCommandRequiresReason(command: SessionCommand): boolean {
  return command === 'cancel';
}

/** Commands reaching `open` serialize on the doctor-global lock. */
export function sessionCommandRequiresDoctorLock(
  command: SessionCommand,
): boolean {
  return SESSION_COMMAND_TARGET[command] === 'open';
}

/** Minutes are required (1..MAX_DELAY_MINUTES, whole) except for clear_delay. */
export function isValidDelayMinutes(
  command: DelayCommand,
  minutes: number | undefined,
): boolean {
  if (command === 'clear_delay') return true;
  return (
    typeof minutes === 'number' &&
    Number.isInteger(minutes) &&
    minutes > 0 &&
    minutes <= MAX_DELAY_MINUTES
  );
}

export type DelayRefusal =
  | 'terminal_session'
  | 'stale_version'
  | 'already_declared'
  | 'no_delay_to_update'
  | 'no_delay_to_clear';

export type DelayPlan =
  | { ok: true; minutes: number | null; nextVersion: number }
  | { ok: false; refusal: DelayRefusal };

/**
 * Decide a delay command against committed session state. Checks run in a
 * fixed order: terminal session, stale version, then command preconditions.
 * Minutes must already satisfy isValidDelayMinutes.
 */
export function planDelayCommand(
  command: DelayCommand,
  current: {
    status: SessionStatus;
    declaredDelayMinutes: number | null;
    delayVersion: number;
  },
  input: { minutes?: number; expectedVersion: number },
): DelayPlan {
  if (isTerminalSessionStatus(current.status))
    return { ok: false, refusal: 'terminal_session' };
  if (current.delayVersion !== input.expectedVersion)
    return { ok: false, refusal: 'stale_version' };
  const hasDelay = current.declaredDelayMinutes !== null;
  if (command === 'declare_delay' && hasDelay)
    return { ok: false, refusal: 'already_declared' };
  if (command === 'update_delay' && !hasDelay)
    return { ok: false, refusal: 'no_delay_to_update' };
  if (command === 'clear_delay' && !hasDelay)
    return { ok: false, refusal: 'no_delay_to_clear' };
  return {
    ok: true,
    minutes: command === 'clear_delay' ? null : input.minutes!,
    nextVersion: current.delayVersion + 1,
  };
}
