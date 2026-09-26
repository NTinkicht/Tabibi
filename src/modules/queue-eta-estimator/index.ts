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
  // Empty DB text is absence of evidence, not a real zero-minute sample.
  // Number('') / Number('   ') otherwise become 0 and are clamped to 2,
  // potentially selecting a spurious historical or observed median.
  return samples
    .map((value) =>
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '')
        ? Number.NaN
        : Number(value),
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
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return Number.NaN;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  const offsetHours = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinutes = match[8] === 'Z' ? 0 : Number(match[11]);
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

  const direction = match[9] === '-' ? -1 : 1;
  return (
    calendar.getTime() - direction * (offsetHours * 60 + offsetMinutes) * 60_000
  );
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
  if (
    !Number.isSafeInteger(patientsAhead) ||
    patientsAhead < 0 ||
    !Number.isFinite(declaredDelayMinutes) ||
    declaredDelayMinutes < 0 ||
    !Number.isFinite(estimatedConsultationMinutes) ||
    estimatedConsultationMinutes <= 0
  ) {
    throw new RangeError(
      'ETA inputs must be finite, non-negative and physically valid',
    );
  }

  const minWaitMinutes = Math.round(
    declaredDelayMinutes +
      patientsAhead * estimatedConsultationMinutes * ETA_MIN_MULTIPLIER,
  );
  const maxWaitMinutes = Math.round(
    declaredDelayMinutes +
      patientsAhead * estimatedConsultationMinutes * ETA_MAX_MULTIPLIER,
  );
  if (!Number.isFinite(minWaitMinutes) || !Number.isFinite(maxWaitMinutes)) {
    throw new RangeError('ETA bounds must be finite');
  }
  return { minWaitMinutes, maxWaitMinutes };
}

export { createEtaRevision, type EtaRevisionInput } from './revision';
export { summarizeWaitRange, type WaitRangeSummary } from './summary';
