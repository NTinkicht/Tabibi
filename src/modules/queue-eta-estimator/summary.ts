import {
  classifyEtaConfidence,
  type EtaConfidence,
  type EtaConfidenceThresholds,
} from './confidence';
import { deriveWaitRangeMetrics, type WaitRange } from './range-metrics';

export type WaitRangeSummary = {
  midpointMinutes: number;
  uncertaintyWidthMinutes: number;
  confidence: EtaConfidence;
};

/**
 * Composes deterministic range metrics and confidence classification without
 * inventing thresholds or recomputing uncertainty independently.
 */
export function summarizeWaitRange(
  range: WaitRange,
  thresholds: EtaConfidenceThresholds,
): WaitRangeSummary {
  const metrics = deriveWaitRangeMetrics(range);

  return {
    ...metrics,
    confidence: classifyEtaConfidence(
      metrics.uncertaintyWidthMinutes,
      thresholds,
    ),
  };
}
