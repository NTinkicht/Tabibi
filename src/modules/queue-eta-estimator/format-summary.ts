import type { EtaConfidence, WaitRangeSummary } from './summary';

export interface FormattedWaitRangeSummary {
  midpointMinutes: number;
  uncertaintyWidthMinutes: number;
  confidence: EtaConfidence;
}

const VALID_CONFIDENCE = new Set<EtaConfidence>(['high', 'medium', 'low']);

/**
 * Validates and copies a deterministic ETA summary for downstream rendering.
 * It deliberately performs no rounding, localization, or ETA recomputation.
 */
export function formatWaitRangeSummary(
  summary: WaitRangeSummary,
): FormattedWaitRangeSummary {
  if (
    !Number.isFinite(summary.midpointMinutes) ||
    summary.midpointMinutes < 0 ||
    !Number.isFinite(summary.uncertaintyWidthMinutes) ||
    summary.uncertaintyWidthMinutes < 0 ||
    !VALID_CONFIDENCE.has(summary.confidence)
  ) {
    throw new RangeError('Wait range summary must contain valid deterministic values');
  }

  return {
    midpointMinutes: summary.midpointMinutes,
    uncertaintyWidthMinutes: summary.uncertaintyWidthMinutes,
    confidence: summary.confidence,
  };
}
