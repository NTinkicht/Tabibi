// Pure model of the operational statistics screen (TAB-P1-05). The API already
// withholds small-cohort averages (null) and returns counts only for totals,
// so this module never derives an average: it validates the payload shape and
// the reporting window.
export const MAX_WINDOW_DAYS = 31;

export type DoctorStatistics = {
  doctorId: string;
  doctorName: string;
  sessions: number;
  completed: number;
  noShow: number;
  cancelled: number;
  averageConsultationSeconds: number | null;
  openedSessions: number;
  lateStarts: number;
  averageStartDelayMinutes: number | null;
};
export type StatisticsTotals = {
  sessions: number;
  completed: number;
  noShow: number;
  cancelled: number;
  openedSessions: number;
  lateStarts: number;
};
export type DelayTrendDay = {
  date: string;
  sessions: number;
  opened: number;
  lateStarts: number;
};
export type StatisticsView = {
  from: string;
  to: string;
  totals: StatisticsTotals;
  doctors: DoctorStatistics[];
  delayTrend: DelayTrendDay[];
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TOTAL_KEYS = [
  'sessions',
  'completed',
  'noShow',
  'cancelled',
  'openedSessions',
  'lateStarts',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('Invalid response');
  return value as number;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid response');
  return value;
}
function nullableNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('Invalid response');
  return value;
}

/** Allow-list parse: only the known aggregate fields are ever kept. */
export function toStatisticsView(payload: unknown): StatisticsView {
  if (
    !isRecord(payload) ||
    !isRecord(payload.totals) ||
    !Array.isArray(payload.doctors) ||
    !Array.isArray(payload.delayTrend)
  )
    throw new Error('Invalid response');
  const totals = payload.totals;
  return {
    from: text(payload.from),
    to: text(payload.to),
    totals: Object.fromEntries(
      TOTAL_KEYS.map((key) => [key, count(totals[key])]),
    ) as StatisticsTotals,
    doctors: payload.doctors.map((row: unknown) => {
      if (!isRecord(row)) throw new Error('Invalid response');
      return {
        doctorId: text(row.doctorId),
        doctorName: text(row.doctorName),
        sessions: count(row.sessions),
        completed: count(row.completed),
        noShow: count(row.noShow),
        cancelled: count(row.cancelled),
        averageConsultationSeconds: nullableNumber(
          row.averageConsultationSeconds,
        ),
        openedSessions: count(row.openedSessions),
        lateStarts: count(row.lateStarts),
        averageStartDelayMinutes: nullableNumber(row.averageStartDelayMinutes),
      };
    }),
    delayTrend: payload.delayTrend.map((row: unknown) => {
      if (!isRecord(row)) throw new Error('Invalid response');
      return {
        date: text(row.date),
        sessions: count(row.sessions),
        opened: count(row.opened),
        lateStarts: count(row.lateStarts),
      };
    }),
  };
}

function dayMs(value: string): number {
  if (!DAY.test(value)) return Number.NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : Number.NaN;
}

/** True when both days are real dates, ordered, and span at most 31 days. */
export function isValidWindow(from: string, to: string): boolean {
  const start = dayMs(from);
  const end = dayMs(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return false;
  return (end - start) / 86_400_000 + 1 <= MAX_WINDOW_DAYS;
}

function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Last seven days ending on the viewer's local today. */
export function defaultWindow(now: Date): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  return { from: localDay(start), to: localDay(now) };
}
