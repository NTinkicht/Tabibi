import { computeQueueEtaRange, type QueueEtaEstimateSource } from './index';
import { createEtaRevision } from './revision';

export interface EtaSnapshotInput {
  patientsAhead: number;
  declaredDelayMinutes: number;
  estimatedConsultationMinutes: number;
  estimateSource: QueueEtaEstimateSource;
  observedSampleCount: number;
}

export interface EtaSnapshot {
  readonly minWaitMinutes: number;
  readonly maxWaitMinutes: number;
  readonly revision: string;
  readonly delayStatus: 'declared' | null;
}

/** Composes an immutable deterministic wait range and revision from committed inputs. */
export function createEtaSnapshot(input: EtaSnapshotInput): EtaSnapshot {
  const range = computeQueueEtaRange(input);
  return Object.freeze({
    ...range,
    revision: createEtaRevision(input),
    delayStatus: input.declaredDelayMinutes > 0 ? 'declared' : null,
  });
}
