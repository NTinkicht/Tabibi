import {
  ETA_MAX_MULTIPLIER,
  ETA_MIN_MULTIPLIER,
  type QueueEtaEstimateSource,
} from './index';

export const ETA_UNCERTAINTY_VERSION = 'eta-uncertainty/v1' as const;

export interface EtaUncertaintyInput {
  clinicId: string;
  sessionId: string;
  targetEntryId: string;
  queueRevision: number;
  evaluatedAt: string;
  declaredDelayMinutes: number;
  activeConsultationRemainingMinutes: number;
  /** Committed eligible service slots ahead, including the active slot if flagged. */
  slotsAhead: number;
  estimatedConsultationMinutes: number;
  estimateSource: QueueEtaEstimateSource;
  activeSlotIncludedInAhead?: boolean;
  calledNotStartedAhead?: number;
  priorityChanged?: boolean;
  sessionStatus: 'open' | 'paused';
}

export interface EtaUncertaintySnapshot {
  readonly earliestMinutes: number;
  readonly expectedMinutes: number;
  readonly latestMinutes: number;
  readonly estimateVersion: typeof ETA_UNCERTAINTY_VERSION;
  readonly queueRevision: number;
  readonly evaluatedAt: string;
  readonly explanationCodes: readonly string[];
}

function absoluteInstant(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/**
 * Deterministic versioned estimate from a committed queue snapshot.
 * Never uses ambient time, silently substitutes a missing revision, or counts
 * the active consultation as both a service slot and remaining time.
 */
export function computeEtaUncertaintyV1(
  input: EtaUncertaintyInput,
): EtaUncertaintySnapshot {
  const {
    clinicId,
    sessionId,
    targetEntryId,
    queueRevision,
    evaluatedAt,
    declaredDelayMinutes: delay,
    activeConsultationRemainingMinutes: active,
    slotsAhead,
    estimatedConsultationMinutes: duration,
    estimateSource,
  } = input;
  const called = input.calledNotStartedAhead ?? 0;
  const activeSlot = input.activeSlotIncludedInAhead === true ? 1 : 0;
  const validSource = [
    'fallback',
    'historical_median',
    'observed_median',
  ].includes(estimateSource);
  if (
    !clinicId?.trim() ||
    !sessionId?.trim() ||
    !targetEntryId?.trim() ||
    !Number.isSafeInteger(queueRevision) ||
    queueRevision < 0 ||
    !absoluteInstant(evaluatedAt) ||
    !Number.isSafeInteger(slotsAhead) ||
    slotsAhead < activeSlot ||
    !Number.isSafeInteger(called) ||
    called < 0 ||
    called > slotsAhead - activeSlot ||
    !Number.isFinite(delay) ||
    delay < 0 ||
    !Number.isFinite(active) ||
    active < 0 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !validSource ||
    input.sessionStatus !== 'open'
  ) {
    throw new RangeError('Incomplete or invalid committed ETA uncertainty input');
  }

  const queuedSlots = slotsAhead - activeSlot;
  const base = delay + active;
  const rawEarliest = base + queuedSlots * duration * ETA_MIN_MULTIPLIER;
  const rawExpected = base + queuedSlots * duration;
  const rawLatest = base + queuedSlots * duration * ETA_MAX_MULTIPLIER;
  if (![rawEarliest, rawExpected, rawLatest].every(Number.isFinite)) {
    throw new RangeError('ETA uncertainty overflow');
  }
  const point = rawEarliest === rawExpected && rawExpected === rawLatest;
  const earliestMinutes = point ? Math.round(rawExpected) : Math.floor(rawEarliest);
  const expectedMinutes = Math.round(rawExpected);
  const latestMinutes = point ? Math.round(rawExpected) : Math.ceil(rawLatest);
  if (
    !Number.isSafeInteger(earliestMinutes) ||
    !Number.isSafeInteger(expectedMinutes) ||
    !Number.isSafeInteger(latestMinutes) ||
    earliestMinutes < 0 ||
    earliestMinutes > expectedMinutes ||
    expectedMinutes > latestMinutes ||
    (!point && earliestMinutes >= latestMinutes)
  ) {
    throw new RangeError('Invalid normalized ETA uncertainty bounds');
  }
  const codes: string[] = [];
  if (queuedSlots > 0) codes.push('queue-depth');
  if (called > 0) codes.push('called-not-started');
  if (active > 0) codes.push('active-consultation-remaining');
  if (delay > 0) codes.push('declared-delay');
  if (input.priorityChanged) codes.push('priority-change');
  codes.push(estimateSource.replace('_', '-'));
  return Object.freeze({
    earliestMinutes,
    expectedMinutes,
    latestMinutes,
    estimateVersion: ETA_UNCERTAINTY_VERSION,
    queueRevision,
    evaluatedAt,
    explanationCodes: Object.freeze(codes),
  });
}

/** Only the exact committed revision may publish this immutable candidate. */
export function mayPublishEtaUncertaintyV1(
  snapshot: EtaUncertaintySnapshot,
  currentQueueRevision: number,
): boolean {
  return (
    Number.isSafeInteger(currentQueueRevision) &&
    currentQueueRevision >= 0 &&
    snapshot.estimateVersion === ETA_UNCERTAINTY_VERSION &&
    snapshot.queueRevision === currentQueueRevision
  );
}
