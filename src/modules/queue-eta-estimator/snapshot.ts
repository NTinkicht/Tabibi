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
  minWaitMinutes: number;
  maxWaitMinutes: number;
  revision: string;
}

/** Composes the deterministic wait range and revision from committed inputs. */
export function createEtaSnapshot(input: EtaSnapshotInput): EtaSnapshot {
  const range = computeQueueEtaRange(input);
  return {
    ...range,
    revision: createEtaRevision(input),
  };
}
