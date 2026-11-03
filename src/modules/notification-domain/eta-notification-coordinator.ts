import type { EtaNotificationBaselineStore } from './eta-notification-baseline';
import type {
  EtaCurrentSourceEpochs,
  EtaNotificationGate,
  EtaNotificationGateResult,
  EtaNotificationSnapshot,
} from './eta-notification-gate';

export type EtaNotificationCoordinatorResult =
  | { status: 'baseline_recorded' }
  | { status: 'baseline_exists_no_change' }
  | { status: 'enqueued'; baselineAdvanced: boolean }
  | Extract<EtaNotificationGateResult, { enqueued: false }>;

/**
 * Wires the pure ETA gate to a durable baseline. The first snapshot seen for an
 * entry becomes the baseline without a notification (queue_entry_created covers
 * the first estimate). After a positive gate result the baseline advances only
 * once the intent is durably enqueued; a crash in between replays safely because
 * the outbox idempotency key is derived from (entry, revision), and a stale or
 * concurrent writer cannot regress the baseline (forward-only compare-and-advance).
 */
export class EtaNotificationCoordinator {
  constructor(
    private readonly gate: EtaNotificationGate,
    private readonly baselines: EtaNotificationBaselineStore,
  ) {}

  async process(input: {
    clinicId: string;
    latest: EtaNotificationSnapshot;
    currentEpochs: EtaCurrentSourceEpochs | null;
    locale?: string | null;
  }): Promise<EtaNotificationCoordinatorResult> {
    const { clinicId, latest } = input;
    const baseline = await this.baselines.load(clinicId, latest.queueEntryId);
    if (baseline === null) {
      // Gate validates; an invalid snapshot is reported, never persisted.
      const probe = await this.gate.submit({
        clinicId,
        lastDelivered: null,
        latest,
        currentEpochs: input.currentEpochs,
        locale: input.locale,
      });
      if (!probe.enqueued && probe.reason !== 'no_baseline') return probe;
      await this.baselines.recordInitial(clinicId, latest);
      return { status: 'baseline_recorded' };
    }
    const result = await this.gate.submit({
      clinicId,
      lastDelivered: baseline,
      latest,
      currentEpochs: input.currentEpochs,
      locale: input.locale,
    });
    if (!result.enqueued) return result;
    const baselineAdvanced = await this.baselines.advance(clinicId, latest);
    return { status: 'enqueued', baselineAdvanced };
  }
}
