import type { Pool } from 'pg';

// TAB-P0-15 data retention: patient session and password-reset rows hold only
// verifiers, but once they are long dead they have no purpose. Rows are kept for a
// short grace after they expire, are revoked or are used (support and abuse
// investigation of a recent sign-in or reset), then deleted. Live rows never match.
export const PATIENT_AUTH_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PURGE_BATCH = 500;

export interface PatientAuthPurgeResult {
  sessions: number;
  resetTokens: number;
}

/**
 * Deletes at most one bounded batch of each kind per call; rows locked by a
 * concurrent sign-in, logout or redemption are skipped and left for the next run.
 */
export async function purgeExpiredPatientAuthArtifacts(
  pool: Pool,
  now: Date = new Date(),
): Promise<PatientAuthPurgeResult> {
  const cutoff = new Date(now.getTime() - PATIENT_AUTH_RETENTION_MS);
  const sessions = await pool.query(
    `DELETE FROM patient_sessions WHERE verifier IN (
       SELECT verifier FROM patient_sessions
        WHERE expires_at <= $1 OR (revoked_at IS NOT NULL AND revoked_at <= $1)
        ORDER BY verifier LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    [cutoff, PURGE_BATCH],
  );
  const resetTokens = await pool.query(
    `DELETE FROM patient_password_reset_tokens WHERE verifier IN (
       SELECT verifier FROM patient_password_reset_tokens
        WHERE expires_at <= $1 OR (used_at IS NOT NULL AND used_at <= $1)
        ORDER BY verifier LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    [cutoff, PURGE_BATCH],
  );
  return {
    sessions: sessions.rowCount ?? 0,
    resetTokens: resetTokens.rowCount ?? 0,
  };
}
