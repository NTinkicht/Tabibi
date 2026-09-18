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

export { summarizeWaitRange, type WaitRangeSummary } from './summary';
