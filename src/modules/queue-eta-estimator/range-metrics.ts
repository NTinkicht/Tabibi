export type WaitRange = {
  minWaitMinutes: number;
  maxWaitMinutes: number;
};

export type WaitRangeMetrics = {
  midpointMinutes: number;
  uncertaintyWidthMinutes: number;
};

/**
 * Derives deterministic ETA range metrics from validated wait bounds.
 * Invalid ranges are rejected instead of being propagated into queue estimates.
 */
export function deriveWaitRangeMetrics(range: WaitRange): WaitRangeMetrics {
  const { minWaitMinutes, maxWaitMinutes } = range;

  if (!Number.isFinite(minWaitMinutes) || !Number.isFinite(maxWaitMinutes)) {
    throw new RangeError('wait range bounds must be finite');
  }

  if (minWaitMinutes < 0 || maxWaitMinutes < 0) {
    throw new RangeError('wait range bounds must be non-negative');
  }

  if (minWaitMinutes > maxWaitMinutes) {
    throw new RangeError('minimum wait cannot exceed maximum wait');
  }

  return {
    midpointMinutes: (minWaitMinutes + maxWaitMinutes) / 2,
    uncertaintyWidthMinutes: maxWaitMinutes - minWaitMinutes,
  };
}
