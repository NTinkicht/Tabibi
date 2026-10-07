import { type QueueEtaEstimateSource } from './index';
import { createEtaRevision } from './revision';

export const ETA_ESTIMATE_VERSION = 'eta-uncertainty/v1' as const;

export type EtaExplanationCode =
  | 'queue_depth'
  | 'called_slot_ahead'
  | 'active_consultation_remaining'
  | 'active_consultation_overrun'
  | 'declared_delay'
  | 'observed_same_day_duration'
  | 'historical_prior'
  | 'fallback_prior'
  | 'priority_order';

export interface EtaSnapshotInput {
  /** Queued service slots ahead, excluding any active consultation represented separately. */
  patientsAhead: number;
  declaredDelayMinutes: number;
  activeConsultationRemainingMinutes: number;
  activeConsultationPresent: boolean;
  calledSlotsAhead: number;
  priorityApplied?: boolean;
  estimatedConsultationMinutes: number;
  estimateSource: QueueEtaEstimateSource;
  observedSampleCount: number;
  queueOrderVersion: number;
  delayVersion?: number;
  /** Trusted immutable evaluation instant captured by the caller's committed snapshot. */
  evaluatedAt: Date;
}

export interface EtaSnapshot {
  readonly earliestMinutes: number;
  readonly expectedMinutes: number;
  readonly latestMinutes: number;
  readonly estimateVersion: typeof ETA_ESTIMATE_VERSION;
  readonly queueRevision: number;
  readonly evaluatedAt: string;
  readonly explanationCodes: readonly EtaExplanationCode[];
  /** Compatibility aliases retained for existing consumers during v1 adoption. */
  readonly minWaitMinutes: number;
  readonly maxWaitMinutes: number;
  readonly revision: string;
  readonly delayStatus: 'declared' | null;
}

function assertValidInput(input: EtaSnapshotInput): void {
  if (
    !Number.isSafeInteger(input.patientsAhead) ||
    input.patientsAhead < 0 ||
    !Number.isFinite(input.declaredDelayMinutes) ||
    input.declaredDelayMinutes < 0 ||
    !Number.isFinite(input.activeConsultationRemainingMinutes) ||
    input.activeConsultationRemainingMinutes < 0 ||
    !Number.isSafeInteger(input.calledSlotsAhead) ||
    input.calledSlotsAhead < 0 ||
    input.calledSlotsAhead > input.patientsAhead ||
    !Number.isFinite(input.estimatedConsultationMinutes) ||
    input.estimatedConsultationMinutes <= 0 ||
    !Number.isSafeInteger(input.queueOrderVersion) ||
    input.queueOrderVersion < 0 ||
    !Number.isFinite(input.evaluatedAt.getTime())
  ) {
    throw new RangeError(
      'ETA inputs must be finite, committed, non-negative and physically valid',
    );
  }
}

function explanationCodes(input: EtaSnapshotInput): EtaExplanationCode[] {
  const codes: EtaExplanationCode[] = [];
  if (input.patientsAhead > 0) codes.push('queue_depth');
  if (input.calledSlotsAhead > 0) codes.push('called_slot_ahead');
  if (input.activeConsultationPresent) {
    codes.push(
      input.activeConsultationRemainingMinutes > 0
        ? 'active_consultation_remaining'
        : 'active_consultation_overrun',
    );
  }
  if (input.priorityApplied) codes.push('priority_order');
  if (input.declaredDelayMinutes > 0) codes.push('declared_delay');
  codes.push(
    input.estimateSource === 'observed_median'
      ? 'observed_same_day_duration'
      : input.estimateSource === 'historical_median'
        ? 'historical_prior'
        : 'fallback_prior',
  );
  return codes;
}

/** Composes the immutable eta-uncertainty/v1 tuple from committed inputs. */
export function createEtaSnapshot(input: EtaSnapshotInput): EtaSnapshot {
  assertValidInput(input);

  const rawEarliest =
    input.declaredDelayMinutes +
    input.activeConsultationRemainingMinutes +
    input.patientsAhead * input.estimatedConsultationMinutes * 0.75;
  const rawExpected =
    input.declaredDelayMinutes +
    input.activeConsultationRemainingMinutes +
    input.patientsAhead * input.estimatedConsultationMinutes;
  const rawLatest =
    input.declaredDelayMinutes +
    input.activeConsultationRemainingMinutes +
    input.patientsAhead * input.estimatedConsultationMinutes * 1.5;

  const pointEstimate =
    rawEarliest === rawExpected && rawExpected === rawLatest;
  const earliestMinutes = pointEstimate
    ? Math.round(rawExpected)
    : Math.floor(rawEarliest);
  const expectedMinutes = Math.round(rawExpected);
  const latestMinutes = pointEstimate
    ? Math.round(rawExpected)
    : Math.ceil(rawLatest);

  if (
    !Number.isFinite(earliestMinutes) ||
    !Number.isFinite(expectedMinutes) ||
    !Number.isFinite(latestMinutes) ||
    earliestMinutes < 0 ||
    earliestMinutes > expectedMinutes ||
    expectedMinutes > latestMinutes ||
    (!pointEstimate && earliestMinutes >= latestMinutes)
  ) {
    throw new RangeError('ETA uncertainty tuple is not physically valid');
  }

  const codes = Object.freeze(explanationCodes(input));
  return Object.freeze({
    earliestMinutes,
    expectedMinutes,
    latestMinutes,
    estimateVersion: ETA_ESTIMATE_VERSION,
    queueRevision: input.queueOrderVersion,
    evaluatedAt: input.evaluatedAt.toISOString(),
    explanationCodes: codes,
    minWaitMinutes: earliestMinutes,
    maxWaitMinutes: latestMinutes,
    revision: createEtaRevision(input),
    delayStatus: input.declaredDelayMinutes > 0 ? 'declared' : null,
  });
}
