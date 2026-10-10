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

class EtaClaimRetryRequiredError extends Error {}

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
   * Replay an ALREADY committed immutable claim using its exact source tuple,
   * canonical snapshot and original evaluation instant. A missing row fails
   * closed; caller-provided timestamps never grant fresh publication.
   * New claims must use claimCurrent() with the trusted PostgreSQL clock.
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

    // The supplied tuple/time is a historical immutable replay locator,
    // NEVER authority to construct a fresh claim at a caller-selected instant.
    return inTransaction(this.pool, async (client) => {
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);
      const found = await client.query<{
        id: string;
        same_payload: boolean;
      }>(
        `SELECT id::text, snapshot=$8::jsonb AS same_payload
           FROM eta_uncertainty_claims
          WHERE clinic_id=$1 AND session_id=$2 AND queue_entry_id=$3
            AND source_epoch=$4 AND clinic_prior_epoch=$5
            AND queue_revision=$6 AND estimate_version='eta-uncertainty/v1'
            AND evaluated_at=$7`,
        [
          scope.clinicId,
          sessionId,
          entryId,
          source.sourceEpoch,
          source.clinicPriorEpoch,
          source.queueRevision,
          snapshot.evaluatedAt,
          JSON.stringify(snapshot),
        ],
      );
      if (!found.rows[0]) throw new EtaPublicationStaleError();
      if (!found.rows[0].same_payload) {
        throw new EtaPublicationConflictError();
      }
      return { claimId: found.rows[0].id, snapshot };
    });
  }

  /**
   * The sole fresh publication path. Its evaluation instant is sampled from
   * the trusted PostgreSQL clock *inside* the source-snapshot transaction,
   * not accepted from a candidate or HTTP caller. The same client and
   * REPEATABLE READ snapshot supply the ETA inputs and both source epochs.
   * Direct SQL is additionally checked by the database claim trigger.
   */
  async claimCurrent(
    scope: ClinicScope,
    sessionId: string,
    entryId: string,
    requestKey: string,
  ): Promise<EtaUncertaintyClaim> {
    if (
      typeof requestKey !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(requestKey)
    ) {
      throw new RangeError(
        'A stable non-secret ETA claim request key is required',
      );
    }

    // An immutable candidate is retained across transaction-level retries:
    // a serialization loser cannot resample the clock and create a different
    // key merely because another transaction committed the same tuple first.
    let frozen: {
      source: EtaSourceTuple;
      snapshot: EtaUncertaintySnapshot;
    } | null = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await inTransaction(this.pool, async (client) => {
          await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          await requireClinicRole(client, scope, [
            'receptionist',
            'clinic_admin',
          ]);

          // Durable replay FIRST, before inspecting changed source epochs.
          // This supports a caller that lost the original commit response and
          // knows only its stable key. It never creates new evidence on replay.
          const receipt = await client.query<{
            claim_id: string;
            session_id: string;
            queue_entry_id: string;
            snapshot: EtaUncertaintySnapshot;
          }>(
            `SELECT receipt.claim_id::text, receipt.session_id::text,
                    receipt.queue_entry_id::text, claim.snapshot
               FROM eta_claim_idempotency_receipts receipt
               JOIN eta_uncertainty_claims claim
                 ON claim.id=receipt.claim_id
                AND claim.clinic_id=receipt.clinic_id
              WHERE receipt.clinic_id=$1 AND receipt.request_key=$2`,
            [scope.clinicId, requestKey],
          );
          if (receipt.rows[0]) {
            const previous = receipt.rows[0];
            if (
              previous.session_id !== sessionId ||
              previous.queue_entry_id !== entryId
            ) {
              throw new EtaPublicationConflictError();
            }
            return {
              claimId: previous.claim_id,
              snapshot: previous.snapshot,
            };
          }

          // The canonical millisecond transaction timestamp is the exact
          // value enforced by the database claim trigger. Across retries
          // preserve the original instant and source snapshot; if the new
          // transaction has a different timestamp, a new INSERT is forbidden.
          let evaluatedAt = frozen?.snapshot.evaluatedAt;
          if (!evaluatedAt) {
            const time = await client.query<{ evaluated_at: Date }>(
              "SELECT date_trunc('milliseconds', transaction_timestamp()) AS evaluated_at",
            );
            const instant = time.rows[0]?.evaluated_at;
            if (
              !(instant instanceof Date) ||
              !Number.isFinite(instant.getTime())
            ) {
              throw new EtaPublicationStaleError();
            }
            evaluatedAt = instant.toISOString();
          }

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
          if (!versions) throw new EtaPublicationStaleError();
          const source: EtaSourceTuple = {
            sourceEpoch: asSafeEpoch(versions.source_epoch),
            clinicPriorEpoch: asSafeEpoch(versions.prior_epoch),
            queueRevision: asSafeEpoch(versions.queue_order_version),
          };
          if (
            frozen &&
            (source.sourceEpoch !== frozen.source.sourceEpoch ||
              source.clinicPriorEpoch !== frozen.source.clinicPriorEpoch ||
              source.queueRevision !== frozen.source.queueRevision)
          ) {
            throw new EtaPublicationStaleError();
          }

          const readModel = await new ReceptionistDashboardService(
            this.pool,
            () => new Date(evaluatedAt),
          ).getSnapshot(scope, sessionId, client);
          const snapshot = readModel.entries.find(
            (entry) => entry.id === entryId,
          )?.eta?.uncertainty;
          if (
            !snapshot ||
            !validSnapshot(snapshot) ||
            snapshot.queueRevision !== source.queueRevision ||
            snapshot.evaluatedAt !== evaluatedAt
          ) {
            throw new EtaPublicationStaleError();
          }
          if (
            frozen &&
            JSON.stringify(snapshot) !== JSON.stringify(frozen.snapshot)
          ) {
            throw new EtaPublicationStaleError();
          }
          if (!frozen) frozen = { source, snapshot };

          const args = [
            scope.clinicId,
            sessionId,
            entryId,
            source.sourceEpoch,
            source.clinicPriorEpoch,
            source.queueRevision,
            evaluatedAt,
            JSON.stringify(snapshot),
          ];
          const lookupSql = `SELECT id::text, snapshot=$8::jsonb AS same_payload
               FROM eta_uncertainty_claims
              WHERE clinic_id=$1 AND session_id=$2 AND queue_entry_id=$3
                AND source_epoch=$4 AND clinic_prior_epoch=$5
                AND queue_revision=$6 AND estimate_version='eta-uncertainty/v1'
                AND evaluated_at=$7`;

          // Exact replay of a tuple committed by a different idempotency key
          // is valid only if its byte-normalized payload is identical.
          const previous = await client.query<{
            id: string;
            same_payload: boolean;
          }>(lookupSql, args);
          let claimId = previous.rows[0]?.id;
          if (previous.rows[0] && !previous.rows[0].same_payload) {
            throw new EtaPublicationConflictError();
          }
          if (!claimId) {
            const inserted = await client.query<{ id: string }>(
              `INSERT INTO eta_uncertainty_claims (
                 clinic_id,session_id,queue_entry_id,source_epoch,
                 clinic_prior_epoch,queue_revision,estimate_version,
                 evaluated_at,snapshot
               ) VALUES ($1,$2,$3,$4,$5,$6,'eta-uncertainty/v1',$7,$8::jsonb)
               ON CONFLICT DO NOTHING
               RETURNING id::text`,
              args,
            );
            claimId = inserted.rows[0]?.id;
            if (!claimId) {
              // Retry from a new snapshot; the winning row can now be read
              // using the preserved tuple/time, never a freshly sampled time.
              throw new EtaClaimRetryRequiredError();
            }
          }

          const receiptInsert = await client.query<{ claim_id: string }>(
            `INSERT INTO eta_claim_idempotency_receipts (
                 clinic_id, request_key, session_id, queue_entry_id, claim_id
               ) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (clinic_id, request_key) DO NOTHING
               RETURNING claim_id::text`,
            [scope.clinicId, requestKey, sessionId, entryId, claimId],
          );
          if (!receiptInsert.rows[0]) {
            // The other transaction may have committed this stable key.
            // Roll back ANY claim written here, then read its receipt anew.
            throw new EtaClaimRetryRequiredError();
          }
          return { claimId, snapshot };
        });
      } catch (error) {
        const serializationFailure =
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === '40001';
        if (
          (serializationFailure ||
            error instanceof EtaClaimRetryRequiredError) &&
          attempt < 4
        ) {
          continue;
        }
        if (
          serializationFailure ||
          error instanceof EtaClaimRetryRequiredError
        ) {
          throw new EtaPublicationStaleError();
        }
        throw error;
      }
    }
    throw new EtaPublicationStaleError();
  }
}
