import type { Pool } from 'pg';

// TAB-P0-15 data retention: staff_sign_in_rate_limit_buckets backs staff sign-in,
// staff invites and every patient sign-in style route. Keys are digests of source
// and account identifiers, and nothing ever deleted a row. Every consumer uses a
// 15 minute fixed window and restarts the window when it has elapsed, so a bucket
// whose window began long ago can never throttle anyone and is only retained data.
export const RATE_LIMIT_BUCKET_RETENTION_MS = 24 * 60 * 60 * 1_000;
const PURGE_BATCH = 500;

/**
 * Deletes at most one bounded batch of stale buckets per call; rows locked by a
 * concurrent attempt are skipped and left for the next run. Returns the count.
 */
export async function purgeStaleSignInRateLimitBuckets(
  pool: Pool,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - RATE_LIMIT_BUCKET_RETENTION_MS);
  const result = await pool.query(
    `DELETE FROM staff_sign_in_rate_limit_buckets WHERE bucket_key IN (
       SELECT bucket_key FROM staff_sign_in_rate_limit_buckets
        WHERE window_started_at <= $1
        ORDER BY bucket_key LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    [cutoff, PURGE_BATCH],
  );
  return result.rowCount ?? 0;
}
