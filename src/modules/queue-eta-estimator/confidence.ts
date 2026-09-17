export type EtaConfidence = 'high' | 'medium' | 'low';

export type EtaConfidenceThresholds = {
  highMaxWidthMinutes: number;
  mediumMaxWidthMinutes: number;
};

/**
 * Classifies ETA confidence from an explicit uncertainty width.
 * Invalid widths or thresholds are rejected instead of fabricating confidence.
 */
export function classifyEtaConfidence(
  uncertaintyWidthMinutes: number,
  thresholds: EtaConfidenceThresholds,
): EtaConfidence {
  const { highMaxWidthMinutes, mediumMaxWidthMinutes } = thresholds;

  if (
    !Number.isFinite(uncertaintyWidthMinutes) ||
    !Number.isFinite(highMaxWidthMinutes) ||
    !Number.isFinite(mediumMaxWidthMinutes)
  ) {
    throw new RangeError('ETA confidence inputs must be finite');
  }

  if (
    uncertaintyWidthMinutes < 0 ||
    highMaxWidthMinutes < 0 ||
    mediumMaxWidthMinutes < 0
  ) {
    throw new RangeError('ETA confidence inputs must be non-negative');
  }

  if (highMaxWidthMinutes > mediumMaxWidthMinutes) {
    throw new RangeError('high confidence threshold cannot exceed medium threshold');
  }

  if (uncertaintyWidthMinutes <= highMaxWidthMinutes) {
    return 'high';
  }

  if (uncertaintyWidthMinutes <= mediumMaxWidthMinutes) {
    return 'medium';
  }

  return 'low';
}
