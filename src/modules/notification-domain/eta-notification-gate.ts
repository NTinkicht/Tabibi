import {
  DEFAULT_MATERIAL_ESTIMATE_CHANGE_THRESHOLDS,
  isMaterialEstimateChange,
  type MaterialEstimateChangeThresholds,
  type QueueEstimateSnapshot,
} from '@/modules/queue-eta-estimator/material-change';
import type { NotificationIntent } from '@/modules/notification-outbox';
import type { QueueNotificationProducer } from './queue-notification-producer';

/**
 * One published ETA snapshot for a queue entry. Carries only the numbers and
 * the contract/epoch identifiers needed to decide comparability; no patient
 * identity, contact data or free text.
 */
export interface EtaNotificationSnapshot extends QueueEstimateSnapshot {
  queueEntryId: string;
  /** Monotonic publication revision of the snapshot for this entry. */
  revision: number;
  estimatorVersion: string;
  sessionEpoch: number;
  priorEpoch: number;
}

/** Authoritative source epochs read now (e.g. EtaClaimService.readSourceEpochs). */
export interface EtaCurrentSourceEpochs {
  sessionEpoch: number;
  priorEpoch: number;
}

export type EtaNotificationReasonCode =
  | 'material_change'
  | 'no_baseline'
  | 'invalid_snapshot'
  | 'entry_mismatch'
  | 'duplicate_revision'
  | 'stale_revision'
  | 'estimator_version_mismatch'
  | 'source_epoch_mismatch'
  | 'not_material';

export type EtaNotificationDecision =
  | { notify: true; reason: 'material_change'; dedupKey: string }
  | {
      notify: false;
      reason: Exclude<EtaNotificationReasonCode, 'material_change'>;
    };

const MAX_ID_LENGTH = 64;

function validSnapshot(s: EtaNotificationSnapshot): boolean {
  const id = s.queueEntryId?.trim();
  return (
    !!id &&
    id.length <= MAX_ID_LENGTH &&
    typeof s.estimatorVersion === 'string' &&
    s.estimatorVersion.trim().length > 0 &&
    Number.isSafeInteger(s.revision) &&
    s.revision > 0 &&
    Number.isSafeInteger(s.sessionEpoch) &&
    s.sessionEpoch >= 0 &&
    Number.isSafeInteger(s.priorEpoch) &&
    s.priorEpoch >= 0 &&
    Number.isFinite(s.minWaitMinutes) &&
    Number.isFinite(s.maxWaitMinutes) &&
    s.minWaitMinutes >= 0 &&
    s.maxWaitMinutes >= s.minWaitMinutes &&
    Number.isSafeInteger(s.queuePosition) &&
    s.queuePosition > 0
  );
}

/** Deterministic dedup key from (entry, snapshot revision). */
export function etaNotificationDedupKey(
  queueEntryId: string,
  revision: number,
): string {
  return `eta:${queueEntryId.trim()}:${revision}`;
}

/**
 * Pure, fail-closed decision on whether a new ETA snapshot warrants a
 * notification relative to the last *delivered* snapshot. Any doubt (no
 * baseline, malformed input, different entry, older/equal revision, mismatched
 * estimator version or source epochs) yields no notification with a reason code.
 */
export function decideEtaNotification(
  lastDelivered: EtaNotificationSnapshot | null,
  latest: EtaNotificationSnapshot,
  currentEpochs: EtaCurrentSourceEpochs | null,
  thresholds: MaterialEstimateChangeThresholds = DEFAULT_MATERIAL_ESTIMATE_CHANGE_THRESHOLDS,
): EtaNotificationDecision {
  if (!validSnapshot(latest))
    return { notify: false, reason: 'invalid_snapshot' };
  if (lastDelivered === null) return { notify: false, reason: 'no_baseline' };
  if (!validSnapshot(lastDelivered)) {
    return { notify: false, reason: 'invalid_snapshot' };
  }
  if (lastDelivered.queueEntryId.trim() !== latest.queueEntryId.trim()) {
    return { notify: false, reason: 'entry_mismatch' };
  }
  if (latest.revision === lastDelivered.revision) {
    return { notify: false, reason: 'duplicate_revision' };
  }
  if (latest.revision < lastDelivered.revision) {
    return { notify: false, reason: 'stale_revision' };
  }
  if (latest.estimatorVersion !== lastDelivered.estimatorVersion) {
    return { notify: false, reason: 'estimator_version_mismatch' };
  }
  // Epochs advance legitimately on queue mutations and delays, so the baseline's
  // epochs are not compared; the latest snapshot must instead be current.
  if (
    currentEpochs === null ||
    latest.sessionEpoch !== currentEpochs.sessionEpoch ||
    latest.priorEpoch !== currentEpochs.priorEpoch
  ) {
    return { notify: false, reason: 'source_epoch_mismatch' };
  }
  if (!isMaterialEstimateChange(lastDelivered, latest, thresholds)) {
    return { notify: false, reason: 'not_material' };
  }
  return {
    notify: true,
    reason: 'material_change',
    dedupKey: etaNotificationDedupKey(latest.queueEntryId, latest.revision),
  };
}

export type EtaNotificationGateResult =
  | { enqueued: true; intent: NotificationIntent }
  | {
      enqueued: false;
      reason: Exclude<EtaNotificationReasonCode, 'material_change'>;
    };

/**
 * Gates ETA-change notifications: enqueues one `estimate_changed_materially`
 * intent only when the decision is positive; the outbox idempotency key makes a
 * repeated submission of the same snapshot revision a replay of one row.
 */
export class EtaNotificationGate {
  constructor(
    private readonly producer: QueueNotificationProducer,
    private readonly thresholds: MaterialEstimateChangeThresholds = DEFAULT_MATERIAL_ESTIMATE_CHANGE_THRESHOLDS,
  ) {}

  async submit(input: {
    clinicId: string;
    lastDelivered: EtaNotificationSnapshot | null;
    latest: EtaNotificationSnapshot;
    currentEpochs: EtaCurrentSourceEpochs | null;
    locale?: string | null;
  }): Promise<EtaNotificationGateResult> {
    const decision = decideEtaNotification(
      input.lastDelivered,
      input.latest,
      input.currentEpochs,
      this.thresholds,
    );
    if (!decision.notify) return { enqueued: false, reason: decision.reason };
    const intent = await this.producer.produce({
      clinicId: input.clinicId,
      queueEntryId: input.latest.queueEntryId.trim(),
      sourceEventId: decision.dedupKey,
      sourceVersion: input.latest.revision,
      notification: {
        eventKey: 'estimate_changed_materially',
        locale: input.locale,
        windowStartMinutes: input.latest.minWaitMinutes,
        windowEndMinutes: input.latest.maxWaitMinutes,
      },
    });
    return { enqueued: true, intent };
  }
}
