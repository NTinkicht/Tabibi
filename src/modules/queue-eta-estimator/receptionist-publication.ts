import type { Pool } from 'pg';
import { type ClinicScope, requireClinicRole } from '@/modules/identity';
import {
  ReceptionistDashboardNotFoundError,
  ReceptionistDashboardService,
  type ReceptionistDashboardSnapshot,
} from '@/modules/receptionist-dashboard';
import { inTransaction } from '@/platform/database/transaction';
import {
  EtaPublicationClaimService,
  type EtaClaimResult,
  type EtaPublicationTarget,
  type EtaSourceEpochs,
} from './publication-claims';
import type { EtaUncertaintySnapshot } from './uncertainty-v1';

/**
 * TAB-P0-11 / #715: the first production consumer of the ETA claim service.
 *
 * Staff-only (receptionist / clinic_admin). The role is checked BEFORE any
 * epoch is read or claim attempted, the target must belong to the scoped
 * clinic, and a target without a committed `eta-uncertainty/v1` snapshot
 * (waiting, session not open, terminal, absent) is refused without a claim.
 * No route, schema, patient-visible field or authorization rule changes.
 */
export class EtaNotPublishableError extends Error {
  constructor() {
    super('No committed eta-uncertainty/v1 snapshot exists for this entry');
    this.name = 'EtaNotPublishableError';
  }
}

export interface DashboardReader {
  getSnapshot(
    scope: ClinicScope,
    sessionId: string,
  ): Promise<ReceptionistDashboardSnapshot>;
}

export interface ClaimPublisher {
  readSourceEpochs(
    clinicId: string,
    sessionId: string,
  ): Promise<EtaSourceEpochs | null>;
  publish(
    target: EtaPublicationTarget,
    compute: (epochs: EtaSourceEpochs) => Promise<EtaUncertaintySnapshot>,
    maxAttempts?: number,
  ): Promise<EtaClaimResult & { outcome: 'created' | 'existing' }>;
}

export class ReceptionistEtaPublisher {
  constructor(
    private readonly pool: Pool,
    private readonly dashboard: DashboardReader = new ReceptionistDashboardService(
      pool,
    ),
    private readonly claims: ClaimPublisher = new EtaPublicationClaimService(
      pool,
    ),
  ) {}

  async publishForEntry(
    scope: ClinicScope,
    sessionId: string,
    entryId: string,
    maxAttempts = 3,
  ): Promise<EtaClaimResult & { outcome: 'created' | 'existing' }> {
    await inTransaction(this.pool, (client) =>
      requireClinicRole(client, scope, ['receptionist', 'clinic_admin']),
    );
    if (!(await this.claims.readSourceEpochs(scope.clinicId, sessionId)))
      throw new ReceptionistDashboardNotFoundError();
    // The snapshot is recomputed from fresh committed state on every attempt
    // (publish() reads the epochs first); a moved epoch makes the claim stale.
    return this.claims.publish(
      { clinicId: scope.clinicId, sessionId, entryId },
      async () => {
        const snapshot = await this.dashboard.getSnapshot(scope, sessionId);
        const uncertainty = snapshot.entries.find((e) => e.id === entryId)?.eta
          ?.uncertainty;
        if (!uncertainty) throw new EtaNotPublishableError();
        return uncertainty;
      },
      maxAttempts,
    );
  }
}
