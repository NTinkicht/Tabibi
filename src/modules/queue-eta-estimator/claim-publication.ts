import type { Pool } from 'pg';
import { type ClinicScope, requireClinicRole } from '@/modules/identity';
import { ReceptionistDashboardService } from '@/modules/receptionist-dashboard';
import {
  ETA_UNCERTAINTY_VERSION,
  type EtaUncertaintySnapshot,
} from '@/modules/queue-eta-estimator/uncertainty-v1';
import { inTransaction } from '@/platform/database/transaction';

/**
 * Internal claim-only persistence boundary for owner-approved WU #610.
 * NOT a guest endpoint and NOT proof that an HTTP GET response is atomic.
 * PostgreSQL BEFORE INSERT locks the canonical session and clinic epochs
 * and rejects stale writes, including direct database callers.
 */
export interface EtaSourceTuple {
  sourceEpoch: number;
  clinicPriorEpoch: number;
  queueRevision: number;
}

export interface EtaUncertaintyClaim {
  claimId: string;
  snapshot: EtaUncertaintySnapshot;
}

export class EtaPublicationStaleError extends Error {
  constructor() {
    super('ETA sources changed or target is no longer eligible');
    this.name = 'EtaPublicationStaleError';
  }
}

export class EtaPublicationConflictError extends Error {
  constructor() {
    super('Different ETA evidence exists for the same immutable source tuple');
    this.name = 'EtaPublicationConflictError';
  }
}

function nonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validSnapshot(snapshot: EtaUncertaintySnapshot): boolean {
  const codes = snapshot.explanationCodes;
  return (
    snapshot.estimateVersion === ETA_UNCERTAINTY_VERSION &&
    nonnegativeInteger(snapshot.queueRevision) &&
    nonnegativeInteger(snapshot.earliestMinutes) &&
    nonnegativeInteger(snapshot.expectedMinutes) &&
    nonnegativeInteger(snapshot.latestMinutes) &&
    snapshot.earliestMinutes <= snapshot.expectedMinutes &&
    snapshot.expectedMinutes <= snapshot.latestMinutes &&
    typeof snapshot.evaluatedAt === 'string' &&
    Number.isFinite(Date.parse(snapshot.evaluatedAt)) &&
    new Date(snapshot.evaluatedAt).toISOString() === snapshot.evaluatedAt &&
    Array.isArray(codes) &&
    codes.every((code) => typeof code === 'string') &&
    Object.keys(snapshot).length === 7
  );
}

function asSafeEpoch(value: string): number {
  const converted = Number(value);
  if (!nonnegativeInteger(converted)) {
    throw new EtaPublicationStaleError();
  }
  return converted;
}

export class EtaUncertaintyClaimService {
  constructor(private readonly pool: Pool) {}

  /**
   * Capture source tuple for an authorized staff actor. A production caller
   * must also compute its candidate from the SAME committed snapshot.
   * The epoch is private; never serialize it in guest or public APIs.
   */
  async readSourceTuple(
    scope: ClinicScope,
    sessionId: string,
    entryId: string,
  ): Promise<EtaSourceTuple> {
    return inTransaction(this.pool, async (client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);
      const result = await client.query<{
        source_epoch: string;
        prior_epoch: string;
        queue_order_version: string;
      }>(
        `SELECT source.source_epoch, prior.prior_epoch,
                session.queue_order_version
           FROM eta_session_source_epochs source
           JOIN consultation_sessions session
             ON session.id = source.session_id
            AND session.clinic_id = source.clinic_id
           JOIN eta_clinic_prior_epochs prior
             ON prior.clinic_id = source.clinic_id
           JOIN queue_entries entry
             ON entry.session_id = source.session_id
            AND entry.clinic_id = source.clinic_id
          WHERE source.clinic_id=$1 AND source.session_id=$2
            AND entry.id=$3 AND session.status='open'
            AND entry.state IN ('checked_in','called','in_consultation')`,
        [scope.clinicId, sessionId, entryId],
      );
      const row = result.rows[0];
      if (!row) throw new EtaPublicationStaleError();
      return {
        sourceEpoch: asSafeEpoch(row.source_epoch),
        clinicPriorEpoch: asSafeEpoch(row.prior_epoch),
        queueRevision: asSafeEpoch(row.queue_order_version),
      };
    });
  }

  /**
   * Persist one immutable exact-source claim, with no stale retries.
   * Database trigger locks and checks source/prior epochs transactionally.
   * If any source changed, the caller must recompute a fresh candidate.
   */
  async claim(
    scope: ClinicScope,
    sessionId: string,
    entryId: string,
    source: EtaSourceTuple,
    snapshot: EtaUncertaintySnapshot,
  ): Promise<EtaUncertaintyClaim> {
    if (
      !nonnegativeInteger(source.sourceEpoch) ||
      !nonnegativeInteger(source.clinicPriorEpoch) ||
      !nonnegativeInteger(source.queueRevision) ||
      !validSnapshot(snapshot) ||
      snapshot.queueRevision !== source.queueRevision
    ) {
      throw new RangeError('Invalid versioned ETA claim input');
    }

    try {
      return await inTransaction(this.pool, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await requireClinicRole(client, scope, [
          'receptionist',
          'clinic_admin',
        ]);
        const payload = JSON.stringify(snapshot);
        const args = [
          scope.clinicId,
          sessionId,
          entryId,
          source.sourceEpoch,
          source.clinicPriorEpoch,
          source.queueRevision,
          snapshot.evaluatedAt,
          payload,
        ];
        // A lost INSERT response must replay the original immutable claim,
        // even if its source has since changed. Authorization is checked first.
        const lookupSql = `SELECT id::text, snapshot=$8::jsonb AS same_payload
             FROM eta_uncertainty_claims
            WHERE clinic_id=$1 AND session_id=$2 AND queue_entry_id=$3
              AND source_epoch=$4 AND clinic_prior_epoch=$5
              AND queue_revision=$6 AND estimate_version='eta-uncertainty/v1'
              AND evaluated_at=$7`;
        const previous = await client.query<{
          id: string;
          same_payload: boolean;
        }>(lookupSql, args);
        if (previous.rows[0]) {
          if (!previous.rows[0].same_payload) {
            throw new EtaPublicationConflictError();
          }
          return { claimId: previous.rows[0].id, snapshot };
        }

        // New claims prove numerical provenance from the SAME committed
        // database snapshot as their source epochs. An old candidate cannot
        // be relabeled with a newer source tuple, even by a trusted caller.
        const current = await client.query<{
          source_epoch: string;
          prior_epoch: string;
          queue_order_version: string;
        }>(
          `SELECT source.source_epoch, prior.prior_epoch,
                  session.queue_order_version
             FROM eta_session_source_epochs source
             JOIN eta_clinic_prior_epochs prior
               ON prior.clinic_id=source.clinic_id
             JOIN consultation_sessions session
               ON session.clinic_id=source.clinic_id
              AND session.id=source.session_id
            WHERE source.clinic_id=$1 AND source.session_id=$2
              AND session.status='open'`,
          [scope.clinicId, sessionId],
        );
        const versions = current.rows[0];
        if (
          !versions ||
          asSafeEpoch(versions.source_epoch) !== source.sourceEpoch ||
          asSafeEpoch(versions.prior_epoch) !== source.clinicPriorEpoch ||
          asSafeEpoch(versions.queue_order_version) !== source.queueRevision
        ) {
          throw new EtaPublicationStaleError();
        }
        const readModel = await new ReceptionistDashboardService(
          this.pool,
          () => new Date(snapshot.evaluatedAt),
        ).getSnapshot(scope, sessionId, client);
        const computed = readModel.entries.find(
          (entry) => entry.id === entryId,
        )?.eta?.uncertainty;
        if (!computed || JSON.stringify(computed) !== payload) {
          throw new EtaPublicationStaleError();
        }

        const inserted = await client.query<{ id: string; snapshot: object }>(
          `INSERT INTO eta_uncertainty_claims (
             clinic_id,session_id,queue_entry_id,
             source_epoch,clinic_prior_epoch,queue_revision,
             estimate_version,evaluated_at,snapshot
           ) VALUES ($1,$2,$3,$4,$5,$6,'eta-uncertainty/v1',$7,$8::jsonb)
           ON CONFLICT (
             clinic_id,session_id,queue_entry_id,source_epoch,
             clinic_prior_epoch,estimate_version,evaluated_at
           ) DO NOTHING
           RETURNING id::text,snapshot`,
          args,
        );
        if (inserted.rows[0]) {
          return {
            claimId: inserted.rows[0].id,
            snapshot,
          };
        }

        // Concurrent identical retries converge on the same immutable row;
        // conflicting normalized values never overwrite committed evidence.
        const existing = await client.query<{
          id: string;
          same_payload: boolean;
        }>(lookupSql, args);
        if (!existing.rows[0]) throw new EtaPublicationStaleError();
        if (!existing.rows[0].same_payload) {
          throw new EtaPublicationConflictError();
        }
        return {
          claimId: existing.rows[0].id,
          snapshot,
        };
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '40001'
      ) {
        throw new EtaPublicationStaleError();
      }
      throw error;
    }
  }
}
