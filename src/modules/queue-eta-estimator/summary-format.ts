import type { EtaConfidence } from './confidence';

export type WaitRangeSummaryInput = {
  midpointMinutes: number;
  uncertaintyWidthMinutes: number;
  confidence: EtaConfidence;
};

export type FormattedWaitRangeSummary = {
  midpointMinutes: number;
  uncertaintyWidthMinutes: number;
  confidence: EtaConfidence;
};

const VALID_CONFIDENCE: ReadonlySet<EtaConfidence> = new Set([
  'high',
  'medium',
  'low',
]);

/**
 * Validates and copies an ETA summary into a stable display-ready shape.
 * It intentionally performs no rounding, localization, or ETA recomputation.
 */
export function formatWaitRangeSummary(
  summary: WaitRangeSummaryInput,
): FormattedWaitRangeSummary {
  const { midpointMinutes, uncertaintyWidthMinutes, confidence } = summary;

  if (
    !Number.isFinite(midpointMinutes) ||
    !Number.isFinite(uncertaintyWidthMinutes)
  ) {
    throw new RangeError('ETA summary numeric fields must be finite');
  }

  if (midpointMinutes < 0 || uncertaintyWidthMinutes < 0) {
    throw new RangeError('ETA summary numeric fields must be non-negative');
  }

  if (!VALID_CONFIDENCE.has(confidence)) {
    throw new RangeError('ETA summary confidence is invalid');
  }

  return {
    midpointMinutes,
    uncertaintyWidthMinutes,
    confidence,
  };
}
