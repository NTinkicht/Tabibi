import type { Pool } from 'pg';

// TAB-P0-15 data retention (staff side): staff session rows and never-accepted staff
// invites hold only verifiers, but once they are long dead they have no purpose. Rows
// are kept for a short grace after they expire or are revoked (support and abuse
// investigation of a recent sign-in or invite), then deleted. Live rows never match.
// Accepted invites are the record of how a membership was granted and are never purged.
export const STAFF_AUTH_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PURGE_BATCH = 500;

export interface StaffAuthPurgeResult {
  sessions: number;
  invites: number;
}

/**
 * Deletes at most one bounded batch of each kind per call; rows locked by a
 * concurrent sign-in, logout or invite acceptance are skipped for the next run.
 */
export async function purgeExpiredStaffAuthArtifacts(
  pool: Pool,
  now: Date = new Date(),
): Promise<StaffAuthPurgeResult> {
  const cutoff = new Date(now.getTime() - STAFF_AUTH_RETENTION_MS);
  const sessions = await pool.query(
    `DELETE FROM staff_sessions WHERE verifier IN (
       SELECT verifier FROM staff_sessions
        WHERE expires_at <= $1 OR (revoked_at IS NOT NULL AND revoked_at <= $1)
        ORDER BY verifier LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    [cutoff, PURGE_BATCH],
  );
  const invites = await pool.query(
    `DELETE FROM staff_invites WHERE id IN (
       SELECT id FROM staff_invites
        WHERE accepted_at IS NULL
          AND (expires_at <= $1 OR (revoked_at IS NOT NULL AND revoked_at <= $1))
        ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    [cutoff, PURGE_BATCH],
  );
  return {
    sessions: sessions.rowCount ?? 0,
    invites: invites.rowCount ?? 0,
  };
}
