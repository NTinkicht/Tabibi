import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { inTransaction } from '@/platform/database/transaction';
import { absoluteTimestampMs } from './index';
import type { EtaUncertaintySnapshot } from './uncertainty-v1';

/**
 * TAB-P0-11 / #610 slice 4: service adapter over the database-enforced
 * `claim_eta_publication` compare-and-set (migration 0044).
 *
 * The epochs and claim keys stay inside this module and the database; callers
 * only receive an outcome. A stale claim is never relabelled: the publisher
 * re-reads the source epochs, recomputes from fresh committed state and tries
 * again, and gives up with EtaPublicationStaleError after a bounded number of
 * attempts. Nothing here changes an API, a patient-visible field or authorization.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const CONTRACT_VERSION = /^[a-z][a-z0-9-]*\/v[0-9]+$/;

export type EtaClaimOutcome = 'created' | 'existing' | 'stale';

export interface EtaSourceEpochs {
  readonly sessionEpoch: number;
  readonly priorEpoch: number;
}

export interface EtaClaimResult {
  readonly outcome: EtaClaimOutcome;
  readonly claimId: string | null;
  readonly evidenceDigest: string | null;
}

export class EtaPublicationStaleError extends Error {
  constructor() {
    super('ETA publication is stale after bounded recomputation');
    this.name = 'EtaPublicationStaleError';
  }
}

export class EtaClaimDigestConflictError extends Error {
  constructor() {
    super('ETA publication claim digest conflict');
    this.name = 'EtaClaimDigestConflictError';
  }
}

/**
 * One canonical UTC instant for hashing and SQL: strict ISO-8601 with an
 * explicit offset (no local-time or impossible-calendar input), preserved to
 * the PostgreSQL microsecond. Fractions finer than a microsecond are refused
 * rather than silently truncated into a shared claim key.
 */
export function canonicalEtaInstant(value: string): string {
  const ms = absoluteTimestampMs(value);
  if (!Number.isFinite(ms))
    throw new TypeError('evaluatedAt must be an absolute instant');
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  if (fraction.length > 6)
    throw new TypeError('evaluatedAt must not exceed microsecond precision');
  const micros = fraction.padEnd(6, '0').slice(3);
  return new Date(ms).toISOString().replace(/Z$/, `${micros}Z`);
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new TypeError(`${label} must be a UUID`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a non-negative safe integer`);
}

function parseEpoch(value: unknown, label: string): number {
  const parsed = Number(value);
  assertEpoch(parsed, label);
  return parsed;
}

/**
 * Digest of the published estimate. Covers every estimate field plus the
 * contract version and evaluation instant, in a fixed key order, and never the
 * epochs, claim keys or any patient identity.
 */
export function computeEtaEvidenceDigest(
  snapshot: EtaUncertaintySnapshot,
): string {
  // Canonical so equal instants in different notations share one digest,
  // matching the database tuple key (timestamptz, microsecond precision).
  const canonical = JSON.stringify([
    'tabibi:eta-evidence:v1',
    snapshot.estimateVersion,
    canonicalEtaInstant(snapshot.evaluatedAt),
    snapshot.queueRevision,
    snapshot.earliestMinutes,
    snapshot.expectedMinutes,
    snapshot.latestMinutes,
    [...snapshot.explanationCodes],
    snapshot.countdownEligible,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface EtaCurrentClaim {
  claimId: string;
  evidenceDigest: string;
  evaluatedAt: string;
}

export interface EtaPublicationTarget {
  clinicId: string;
  sessionId: string;
  entryId: string;
}

export class EtaPublicationClaimService {
  constructor(private readonly pool: Pool) {}

  /** Current epochs for a session, or null when it is not in the clinic. */
  async readSourceEpochs(
    clinicId: string,
    sessionId: string,
  ): Promise<EtaSourceEpochs | null> {
    assertUuid(clinicId, 'clinicId');
    assertUuid(sessionId, 'sessionId');
    const result = await this.pool.query<{
      session_epoch: string;
      prior_epoch: string;
    }>(
      `SELECT s.eta_source_epoch AS session_epoch,
              COALESCE(pe.eta_prior_epoch, 0) AS prior_epoch
         FROM consultation_sessions s
         LEFT JOIN clinic_doctor_eta_prior_epochs pe
           ON pe.clinic_id = s.clinic_id AND pe.doctor_id = s.doctor_id
        WHERE s.id = $1 AND s.clinic_id = $2`,
      [sessionId, clinicId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      sessionEpoch: parseEpoch(row.session_epoch, 'session epoch'),
      priorEpoch: parseEpoch(row.prior_epoch, 'prior epoch'),
    };
  }

  /**
   * The newest claim for the entry that is still current: both of its epochs
   * equal the epochs now, in one statement (one consistent snapshot). Returns
   * null when there is none, when any source epoch moved after the claim (an
   * older claim is never relabelled as current) or when the tuple is not in
   * the clinic. Epochs and keys are never returned.
   */
  async readCurrentClaim(
    target: EtaPublicationTarget,
    contractVersion?: string,
  ): Promise<EtaCurrentClaim | null> {
    assertUuid(target.clinicId, 'clinicId');
    assertUuid(target.sessionId, 'sessionId');
    assertUuid(target.entryId, 'entryId');
    if (
      contractVersion !== undefined &&
      !CONTRACT_VERSION.test(contractVersion)
    )
      throw new RangeError('contractVersion is malformed');
    const result = await this.pool.query<{
      id: string;
      evidence_digest: string;
      evaluated_at: Date;
    }>(
      `SELECT c.id, c.evidence_digest, c.evaluated_at
         FROM consultation_sessions s
         LEFT JOIN clinic_doctor_eta_prior_epochs pe
           ON pe.clinic_id = s.clinic_id AND pe.doctor_id = s.doctor_id
         JOIN eta_publication_claims c
           ON c.clinic_id = s.clinic_id AND c.session_id = s.id
          AND c.session_epoch = s.eta_source_epoch
          AND c.prior_epoch = COALESCE(pe.eta_prior_epoch, 0)
        WHERE s.id = $1 AND s.clinic_id = $2 AND c.entry_id = $3
          AND ($4::text IS NULL OR c.contract_version = $4)
        ORDER BY c.evaluated_at DESC, c.created_at DESC, c.id DESC
        LIMIT 1`,
      [
        target.sessionId,
        target.clinicId,
        target.entryId,
        contractVersion ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (
      !UUID.test(row.id) ||
      !DIGEST.test(row.evidence_digest) ||
      !(row.evaluated_at instanceof Date)
    )
      throw new Error('eta_publication_claims returned a malformed claim');
    return {
      claimId: row.id,
      evidenceDigest: row.evidence_digest,
      evaluatedAt: canonicalEtaInstant(row.evaluated_at.toISOString()),
    };
  }

  /**
   * One atomic claim. `stale` means an expected epoch moved (or the
   * entry/session/clinic tuple does not match); the caller must recompute.
   */
  async claim(
    target: EtaPublicationTarget,
    expected: EtaSourceEpochs,
    snapshot: EtaUncertaintySnapshot,
  ): Promise<EtaClaimResult> {
    assertUuid(target.clinicId, 'clinicId');
    assertUuid(target.sessionId, 'sessionId');
    assertUuid(target.entryId, 'entryId');
    assertEpoch(expected.sessionEpoch, 'expected session epoch');
    assertEpoch(expected.priorEpoch, 'expected prior epoch');
    const evaluatedAt = canonicalEtaInstant(snapshot.evaluatedAt);
    const evidenceDigest = computeEtaEvidenceDigest(snapshot);
    try {
      const result = await inTransaction(this.pool, (client) =>
        client.query<{
          outcome: string;
          claim_id: string | null;
          claimed_digest: string | null;
        }>(
          `SELECT outcome, claim_id, claimed_digest
             FROM claim_eta_publication($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            target.clinicId,
            target.sessionId,
            target.entryId,
            expected.sessionEpoch,
            expected.priorEpoch,
            snapshot.estimateVersion,
            evaluatedAt,
            evidenceDigest,
          ],
        ),
      );
      const row = result.rows[0];
      if (!row) throw new Error('claim_eta_publication returned no row');
      if (
        row.outcome !== 'created' &&
        row.outcome !== 'existing' &&
        row.outcome !== 'stale'
      )
        throw new Error('claim_eta_publication returned an unknown outcome');
      if (row.outcome === 'stale') {
        if (row.claim_id !== null || row.claimed_digest !== null)
          throw new Error('claim_eta_publication returned a malformed claim');
      } else if (
        typeof row.claim_id !== 'string' ||
        !UUID.test(row.claim_id) ||
        row.claimed_digest !== evidenceDigest ||
        !DIGEST.test(row.claimed_digest)
      ) {
        throw new Error('claim_eta_publication returned a malformed claim');
      }
      return {
        outcome: row.outcome,
        claimId: row.claim_id,
        evidenceDigest: row.claimed_digest,
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      // 23505: same tuple, different digest. 40001: a source moved while the
      // claim was taking its locks, which is a stale claim by definition.
      if (code === '23505') throw new EtaClaimDigestConflictError();
      if (code === '40001')
        return { outcome: 'stale', claimId: null, evidenceDigest: null };
      throw error;
    }
  }

  /**
   * Reads the epochs FIRST, then recomputes the estimate from committed state
   * via `compute`, then claims against exactly those epochs. Any source change
   * after the epoch read bumps an epoch, so the claim goes stale and the loop
   * recomputes from a fresh snapshot instead of publishing outdated evidence.
   * `compute` must read its inputs after receiving the epochs.
   */
  async publish(
    target: EtaPublicationTarget,
    compute: (epochs: EtaSourceEpochs) => Promise<EtaUncertaintySnapshot>,
    maxAttempts = 3,
  ): Promise<EtaClaimResult & { outcome: 'created' | 'existing' }> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)
      throw new RangeError('maxAttempts must be an integer from 1 to 10');
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const epochs = await this.readSourceEpochs(
        target.clinicId,
        target.sessionId,
      );
      if (!epochs) throw new EtaPublicationStaleError();
      const snapshot = await compute(epochs);
      const result = await this.claim(target, epochs, snapshot);
      if (result.outcome !== 'stale')
        return result as EtaClaimResult & { outcome: 'created' | 'existing' };
    }
    throw new EtaPublicationStaleError();
  }
}
