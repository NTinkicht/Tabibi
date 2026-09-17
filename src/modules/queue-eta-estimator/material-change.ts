export type QueueEstimateSnapshot = {
  minWaitMinutes: number;
  maxWaitMinutes: number;
  queuePosition: number;
  sessionStatus?: 'active' | 'delayed' | 'cancelled';
  approachingTurn?: boolean;
};

export type MaterialEstimateChangeThresholds = {
  midpointMinutes: number;
  uncertaintyMinutes: number;
  queuePlaces: number;
};

export const DEFAULT_MATERIAL_ESTIMATE_CHANGE_THRESHOLDS: MaterialEstimateChangeThresholds =
  {
    midpointMinutes: 10,
    uncertaintyMinutes: 15,
    queuePlaces: 2,
  };

/**
 * Applies Tabibi's deterministic default material-change policy without any
 * provider, clock, or mutable-state dependency.
 */
export function isMaterialEstimateChange(
  previous: QueueEstimateSnapshot,
  current: QueueEstimateSnapshot,
  thresholds: MaterialEstimateChangeThresholds = DEFAULT_MATERIAL_ESTIMATE_CHANGE_THRESHOLDS,
): boolean {
  const previousMidpoint =
    (previous.minWaitMinutes + previous.maxWaitMinutes) / 2;
  const currentMidpoint =
    (current.minWaitMinutes + current.maxWaitMinutes) / 2;
  const previousUncertainty =
    previous.maxWaitMinutes - previous.minWaitMinutes;
  const currentUncertainty = current.maxWaitMinutes - current.minWaitMinutes;

  if (Math.abs(currentMidpoint - previousMidpoint) >= thresholds.midpointMinutes) {
    return true;
  }
  if (
    Math.abs(currentUncertainty - previousUncertainty) >=
    thresholds.uncertaintyMinutes
  ) {
    return true;
  }
  if (
    Math.abs(current.queuePosition - previous.queuePosition) >=
    thresholds.queuePlaces
  ) {
    return true;
  }

  const becameDisrupted =
    current.sessionStatus !== previous.sessionStatus &&
    (current.sessionStatus === 'delayed' ||
      current.sessionStatus === 'cancelled');
  if (becameDisrupted) return true;

  return current.approachingTurn === true && previous.approachingTurn !== true;
}
