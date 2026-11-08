export type UpdatedAgoLocale = 'ar' | 'en' | 'fr';

/** Relative-age unit for a snapshot timestamp: seconds, minutes, or hours. */
export type UpdatedAgo = { unit: 'second' | 'minute' | 'hour'; value: number };

/**
 * Age of a server `generatedAt` stamp relative to the device clock. Device clock
 * skew can only make the age look older or younger, never negative: the result
 * is clamped at zero, and an unparsable stamp yields null (show nothing).
 */
export function updatedAgo(
  generatedAt: string,
  nowMs: number,
): UpdatedAgo | null {
  const generatedMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedMs)) return null;
  const seconds = Math.max(0, Math.floor((nowMs - generatedMs) / 1_000));
  if (seconds < 60) return { unit: 'second', value: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: 'minute', value: minutes };
  return { unit: 'hour', value: Math.floor(minutes / 60) };
}

const PHRASES: Record<
  UpdatedAgoLocale,
  (value: number, unit: UpdatedAgo['unit']) => string
> = {
  fr: (value, unit) =>
    `Mis à jour il y a ${value} ${unit === 'second' ? 's' : unit === 'minute' ? 'min' : 'h'}`,
  ar: (value, unit) =>
    `آخر تحديث قبل ${value} ${unit === 'second' ? 'ثانية' : unit === 'minute' ? 'دقيقة' : 'ساعة'}`,
  en: (value, unit) =>
    `Updated ${value} ${unit === 'second' ? 's' : unit === 'minute' ? 'min' : 'h'} ago`,
};

/** Localised "updated N s/min/h ago" sentence. */
export function formatUpdatedAgo(
  age: UpdatedAgo,
  locale: UpdatedAgoLocale,
): string {
  return PHRASES[locale](age.value, age.unit);
}

/** Re-render cadence for the relative age; coarse to avoid per-second churn. */
export const UPDATED_AGO_TICK_MS = 5_000;

/** Starts the 5 s clock tick and returns its cleanup (clears the interval). */
export function startUpdatedAgoTicker(
  setNowMs: (nowMs: number) => void,
  now: () => number = Date.now,
): () => void {
  const timer = setInterval(() => setNowMs(now()), UPDATED_AGO_TICK_MS);
  return () => clearInterval(timer);
}
