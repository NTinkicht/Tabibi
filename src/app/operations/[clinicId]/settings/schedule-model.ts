// TAB-UI-15 (#829) slice 4: pure helpers for the weekly template, session
// generation and absence panels (docs/design/clinic-setup.md). Bodies mirror
// createTemplateSchema, generationSchema and absenceSchema.

export interface TemplateRow {
  id: string;
  weekday: number;
  localStartTime: string;
  localEndTime: string;
  occurrenceIndex: number;
  active: boolean;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The clinic week starts on Sunday in both languages: weekday 0 = Sunday.
export const WEEKDAY_ORDER = [0, 1, 2, 3, 4, 5, 6] as const;

// The database returns `HH:MM:SS`; the form and the API use `HH:MM`.
export function toHhmm(time: string): string {
  return time.slice(0, 5);
}

export function parseTemplates(raw: unknown): TemplateRow[] | null {
  const list = (raw as { templates?: unknown } | null)?.templates;
  if (!Array.isArray(list)) return null;
  const rows: TemplateRow[] = [];
  for (const t of list as Record<string, unknown>[]) {
    if (
      typeof t?.id !== 'string' ||
      !Number.isInteger(t.weekday) ||
      (t.weekday as number) < 0 ||
      (t.weekday as number) > 6 ||
      typeof t.localStartTime !== 'string' ||
      typeof t.localEndTime !== 'string' ||
      !Number.isInteger(t.occurrenceIndex) ||
      typeof t.active !== 'boolean'
    )
      return null;
    rows.push({
      id: t.id,
      weekday: t.weekday as number,
      localStartTime: toHhmm(t.localStartTime),
      localEndTime: toHhmm(t.localEndTime),
      occurrenceIndex: t.occurrenceIndex as number,
      active: t.active,
    });
  }
  return rows;
}

// Active ranges of one weekday, earliest first.
export function activeRanges(
  templates: TemplateRow[],
  weekday: number,
): TemplateRow[] {
  return templates
    .filter((t) => t.weekday === weekday && t.active)
    .sort((a, b) => a.localStartTime.localeCompare(b.localStartTime));
}

// The next free index counts inactive rows too: it stays unique per weekday.
export function nextOccurrenceIndex(
  templates: TemplateRow[],
  weekday: number,
): number {
  return templates
    .filter((t) => t.weekday === weekday)
    .reduce((max, t) => Math.max(max, t.occurrenceIndex + 1), 0);
}

export type RangeError = 'time_invalid' | 'end_before_start';

export function buildTemplateBody(input: {
  doctorId: string;
  weekday: number;
  start: string;
  end: string;
  templates: TemplateRow[];
}):
  | {
      ok: true;
      body: {
        doctorId: string;
        weekday: number;
        localStartTime: string;
        localEndTime: string;
        occurrenceIndex: number;
      };
    }
  | { ok: false; error: RangeError } {
  if (!HHMM.test(input.start) || !HHMM.test(input.end))
    return { ok: false, error: 'time_invalid' };
  if (input.start >= input.end) return { ok: false, error: 'end_before_start' };
  return {
    ok: true,
    body: {
      doctorId: input.doctorId,
      weekday: input.weekday,
      localStartTime: input.start,
      localEndTime: input.end,
      occurrenceIndex: nextOccurrenceIndex(input.templates, input.weekday),
    },
  };
}

export const GENERATION_WEEKS = [4, 8] as const;

export function buildGenerationBody(input: {
  doctorId: string;
  startDate: string;
  weeks: number;
}):
  | {
      ok: true;
      body: { doctorId: string; startDate: string; daysAhead: 28 | 56 };
    }
  | { ok: false } {
  if (!DAY.test(input.startDate)) return { ok: false };
  const { doctorId, startDate } = input;
  if (input.weeks === 4)
    return { ok: true, body: { doctorId, startDate, daysAhead: 28 } };
  if (input.weeks === 8)
    return { ok: true, body: { doctorId, startDate, daysAhead: 56 } };
  return { ok: false };
}

export function parseGenerated(raw: unknown): number | null {
  const n = (raw as { generated?: unknown } | null)?.generated;
  return Number.isInteger(n) && (n as number) >= 0 ? (n as number) : null;
}

// Last requested day (inclusive) of a run of `weeks` weeks from `startDate`.
export function periodEnd(startDate: string, weeks: number): string {
  const d = new Date(`${startDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7 - 1);
  return d.toISOString().slice(0, 10);
}

export function parseAbsences(raw: unknown): string[] | null {
  const list = (raw as { absences?: unknown } | null)?.absences;
  if (!Array.isArray(list)) return null;
  if (!list.every((d) => typeof d === 'string' && DAY.test(d))) return null;
  return [...(list as string[])].sort();
}

// 2026-11-08 is a Sunday: weekday n is that day plus n.
export function weekdayName(weekday: number, locale: 'ar' | 'fr'): string {
  return new Intl.DateTimeFormat(`${locale}-DZ-u-nu-latn`, {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2026, 10, 8 + weekday)));
}

// A calendar day has no time zone: format it as UTC so the shown date is the stored one.
export function formatLongDay(day: string, locale: 'ar' | 'fr'): string {
  return new Intl.DateTimeFormat(`${locale}-DZ-u-nu-latn`, {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}

export function fillTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) =>
    String(values[k] ?? ''),
  );
}
