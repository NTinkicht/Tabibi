import type {
  PublicWaitingRoomEntry,
  PublicWaitingRoomSnapshot,
} from './index';

export const POLL_INTERVAL_MS = 15_000;
export const MAX_BACKOFF_MS = 60_000;
export const STALE_AFTER_MS = 60_000;
export const NEXT_LIST_LIMIT = 5;

export interface WaitingRoomTvView {
  /** Called labels, most recent first; the first one is shown large. */
  called: string[];
  /** Next checked-in labels in display order (at most NEXT_LIST_LIMIT). */
  next: string[];
  /** Checked-in patients beyond the listed ones (count only). */
  moreArrived: number;
  /** `waiting` entries are counted, never listed. */
  notYetArrived: number;
}

/**
 * The API returns entries in canonical display order (called, checked_in,
 * waiting). The most recent call is the last called entry, so called labels are
 * reversed to put it first. Only public labels survive this projection.
 */
export function buildTvView(
  entries: PublicWaitingRoomEntry[],
): WaitingRoomTvView {
  const called = entries
    .filter((entry) => entry.state === 'called')
    .map((entry) => entry.publicDisplayLabel)
    .reverse();
  const checkedIn = entries
    .filter((entry) => entry.state === 'checked_in')
    .map((entry) => entry.publicDisplayLabel);
  return {
    called,
    next: checkedIn.slice(0, NEXT_LIST_LIMIT),
    moreArrived: Math.max(0, checkedIn.length - NEXT_LIST_LIMIT),
    notYetArrived: entries.filter((entry) => entry.state === 'waiting').length,
  };
}

/** Delay before the next poll: 15 s when healthy, doubling per failure up to 60 s. */
export function nextPollDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return POLL_INTERVAL_MS;
  return Math.min(
    MAX_BACKOFF_MS,
    POLL_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 8),
  );
}

/** Stale once 60 s have passed without a successful response (clock-skew safe). */
export function isStale(lastSuccessAtMs: number, nowMs: number): boolean {
  return nowMs - lastSuccessAtMs >= STALE_AFTER_MS;
}

/**
 * Validates a polled body against the public allow-list shape. Anything else
 * is treated as a failure so unexpected data is never rendered as current.
 */
export function parseSnapshot(
  value: unknown,
): PublicWaitingRoomSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as Record<string, unknown>;
  const session = body.session as Record<string, unknown> | undefined;
  if (
    typeof body.generatedAt !== 'string' ||
    Number.isNaN(Date.parse(body.generatedAt)) ||
    !session ||
    (session.pauseStatus !== 'active' && session.pauseStatus !== 'paused') ||
    typeof session.declaredDelayMinutes !== 'number' ||
    !Number.isFinite(session.declaredDelayMinutes) ||
    !Array.isArray(body.entries)
  ) {
    return null;
  }
  const entries: PublicWaitingRoomEntry[] = [];
  for (const raw of body.entries) {
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry?.publicDisplayLabel !== 'string' ||
      (entry.state !== 'waiting' &&
        entry.state !== 'checked_in' &&
        entry.state !== 'called')
    ) {
      return null;
    }
    entries.push({
      publicDisplayLabel: entry.publicDisplayLabel,
      state: entry.state,
      called: entry.state === 'called',
    });
  }
  return {
    session: {
      pauseStatus: session.pauseStatus,
      declaredDelayMinutes: Math.max(0, session.declaredDelayMinutes),
    },
    generatedAt: body.generatedAt,
    entries,
  };
}
