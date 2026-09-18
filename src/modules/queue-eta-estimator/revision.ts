export interface EtaRevisionInput {
  patientsAhead: number;
  declaredDelayMinutes: number;
  estimatedConsultationMinutes: number;
  estimateSource: 'fallback' | 'historical_median' | 'observed_median';
  observedSampleCount: number;
}

/**
 * Produces a stable, opaque revision token from the committed inputs that
 * determine an ETA. It intentionally excludes wall-clock and random state so
 * identical committed inputs always produce the same revision.
 */
export function createEtaRevision(input: EtaRevisionInput): string {
  const canonical = [
    input.patientsAhead,
    input.declaredDelayMinutes,
    input.estimatedConsultationMinutes,
    input.estimateSource,
    input.observedSampleCount,
  ].join(':');

  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `eta-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
