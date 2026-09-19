export const FALLBACK_CONSULTATION_MINUTES = 15;
export const MIN_ESTIMATE_SAMPLES = 3;
export const MIN_SAMPLE_MINUTES = 2;
export const MAX_SAMPLE_MINUTES = 120;
export const ETA_MIN_MULTIPLIER = 0.75;
export const ETA_MAX_MULTIPLIER = 1.5;
export const MAX_HISTORICAL_SAMPLES = 20;

export type QueueEtaEstimateSource =
  | 'fallback'
  | 'historical_median'
  | 'observed_median';

type DurationSample = number | string | null | undefined;

export interface ConsultationEstimate {
  estimatedConsultationMinutes: number;
  estimateSource: QueueEtaEstimateSource;
  observedSampleCount: number;
}

export interface QueueEtaRangeInput {
  patientsAhead: number;
  declaredDelayMinutes: number;
  estimatedConsultationMinutes: number;
}

export interface QueueEtaRange {
  minWaitMinutes: number;
  maxWaitMinutes: number;
}

export interface ActiveConsultationRemainingInput {
  startedAt: Date | string;
  now: Date | string;
  estimatedConsultationMinutes: number;
}

function normalizeSamples(samples: readonly DurationSample[]): number[] {
  return samples
    .map((value) =>
      value === null || value === undefined ? Number.NaN : Number(value),
    )
    .filter((value) => Number.isFinite(value))
    .map((value) =>
      Math.min(MAX_SAMPLE_MINUTES, Math.max(MIN_SAMPLE_MINUTES, value)),
    );
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle]!;
  return (ordered[middle - 1]! + ordered[middle]!) / 2;
}

/**
 * Selects one deterministic consultation-duration estimate. Current-session
 * evidence always takes precedence over historical evidence once it reaches
 * the shared minimum sample threshold.
 */
export function selectConsultationEstimate(
  currentSessionSamples: readonly DurationSample[],
  historicalSamples: readonly DurationSample[] = [],
): ConsultationEstimate {
  const current = normalizeSamples(currentSessionSamples);
  if (current.length >= MIN_ESTIMATE_SAMPLES) {
    return {
      estimatedConsultationMinutes: median(current),
      estimateSource: 'observed_median',
      observedSampleCount: current.length,
    };
  }

  const historical = normalizeSamples(historicalSamples);
  if (historical.length >= MIN_ESTIMATE_SAMPLES) {
    return {
      estimatedConsultationMinutes: median(historical),
      estimateSource: 'historical_median',
      observedSampleCount: current.length,
    };
  }

  return {
    estimatedConsultationMinutes: FALLBACK_CONSULTATION_MINUTES,
    estimateSource: 'fallback',
    observedSampleCount: current.length,
  };
}

/**
 * Resolves only absolute ISO date-times or valid Date instances. Rejects
 * offset-free, calendar-normalized, or otherwise ambiguous timestamps.
 */
function absoluteTimestampMs(value: Date | string): number {
  if (value instanceof Date) return value.getTime();

  const match =
    /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,9}))?(Z|([+-])(\\d{2}):(\\d{2}))$/.exec(
      value,
    );
  if (!match) return Number.NaN;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone, sign, offsetHourText, offsetMinuteText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millis = Number((fraction ?? '').padEnd(3, '0').slice(0, 3));
  const offsetHours = zone === 'Z' ? 0 : Number(offsetHourText);
  const offsetMinutes = zone === 'Z' ? 0 : Number(offsetMinuteText);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  ) {
    return Number.NaN;
  }

  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, millis);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return Number.NaN;
  }

  const direction = sign === '-' ? -1 : 1;
  return calendar.getTime() - direction * (offsetHours * 60 + offsetMinutes) * 60_000;
}

/**
 * Computes the deterministic whole-minute contribution of an active
 * consultation. Invalid or future timestamps fail closed with no added wait.
 */
export function computeActiveConsultationRemainingMinutes({
  startedAt,
  now,
  estimatedConsultationMinutes,
}: ActiveConsultationRemainingInput): number {
  const startedAtMs = absoluteTimestampMs(startedAt);
  const nowMs = absoluteTimestampMs(now);
  if (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(nowMs) ||
    startedAtMs > nowMs ||
    !Number.isFinite(estimatedConsultationMinutes) ||
    estimatedConsultationMinutes <= 0
  ) {
    return 0;
  }

  const boundedEstimate = Math.min(
    MAX_SAMPLE_MINUTES,
    Math.max(MIN_SAMPLE_MINUTES, estimatedConsultationMinutes),
  );
  const elapsedMinutes = (nowMs - startedAtMs) / 60_000;
  return Math.max(0, Math.ceil(boundedEstimate - elapsedMinutes));
}

/** Applies the established WU9/WU10 delay and bounded uncertainty policy. */
export function computeQueueEtaRange({
  patientsAhead,
  declaredDelayMinutes,
  estimatedConsultationMinutes,
}: QueueEtaRangeInput): QueueEtaRange {
  return {
    minWaitMinutes: Math.round(
      declaredDelayMinutes +
        patientsAhead * estimatedConsultationMinutes * ETA_MIN_MULTIPLIER,
    ),
    maxWaitMinutes: Math.round(
      declaredDelayMinutes +
        patientsAhead * estimatedConsultationMinutes * ETA_MAX_MULTIPLIER,
    ),
  };
}

export { createEtaRevision, type EtaRevisionInput } from './revision';
export { summarizeWaitRange, type WaitRangeSummary } from './summary';
