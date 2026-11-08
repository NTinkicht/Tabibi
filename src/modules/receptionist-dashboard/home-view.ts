import type { receptionistCopy } from '@/modules/localization/receptionist';

// TAB-UI-14: pure view helpers for the reception home (docs/design/reception-home.md).

export type HomeCopy =
  | (typeof receptionistCopy)['fr']
  | (typeof receptionistCopy)['ar'];

export type SessionStatus =
  | 'planned'
  | 'open'
  | 'paused'
  | 'closed'
  | 'cancelled';

/** Aggregate queue counts per session (G-17). Counts only; no identities. */
export interface QueueCounts {
  waiting: number;
  checkedIn: number;
  called: number;
  inConsultation: number;
  completed: number;
  noShow: number;
  cancelled: number;
}

export type StatusTone =
  | 'arrived'
  | 'called'
  | 'warning'
  | 'neutral'
  | 'danger';

/** planned = info tint, open = primary tint, paused = warning, closed = neutral, cancelled = danger. */
export function statusTone(status: SessionStatus): StatusTone {
  switch (status) {
    case 'planned':
      return 'arrived';
    case 'open':
      return 'called';
    case 'paused':
      return 'warning';
    case 'closed':
      return 'neutral';
    case 'cancelled':
      return 'danger';
  }
}

const COUNT_ORDER = [
  'checkedIn',
  'waiting',
  'called',
  'inConsultation',
  'completed',
  'noShow',
] as const;

/** "4 arrivés · 2 pas encore · 1 appelé · 6 terminés": zero counts are omitted. */
export function countsLine(
  counts: QueueCounts | undefined,
  t: HomeCopy,
): string {
  const parts: string[] = [];
  for (const key of COUNT_ORDER) {
    const n = counts?.[key] ?? 0;
    if (!Number.isInteger(n) || n <= 0) continue;
    const label = n === 1 ? t.homeCounts[key].one : t.homeCounts[key].other;
    parts.push(`${n} ${label}`);
  }
  return parts.length > 0 ? parts.join(' · ') : t.homeCountsNone;
}

/** Shift a YYYY-MM-DD calendar date by whole days (calendar arithmetic, no time zone). */
export function shiftDate(date: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days),
  );
  return shifted.toISOString().slice(0, 10);
}

export function formatClock(
  instant: string,
  locale: 'ar' | 'fr',
  timezone: string,
): string {
  return new Intl.DateTimeFormat(
    locale === 'ar' ? 'ar-DZ-u-nu-latn' : 'fr-DZ',
    {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: timezone,
    },
  ).format(new Date(instant));
}
