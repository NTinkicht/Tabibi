import type { Pool } from 'pg';

// TAB-P0-15 data retention: guest_status_rate_limit_buckets and
// guest_push_rate_limit_buckets hold digest-keyed throttling counters. Their
// routes only clean them opportunistically while guests keep calling, so a quiet
// clinic keeps old rows forever. The longest live window is the one hour push
// resend window, so a bucket whose window began a day ago can never throttle
// anyone and is only retained data.
export const GUEST_RATE_LIMIT_BUCKET_RETENTION_MS = 24 * 60 * 60 * 1_000;
const PURGE_BATCH = 500;

/**
 * Deletes at most one bounded batch of stale buckets per table per call; rows
 * locked by a concurrent request are skipped and left for the next run.
 * Returns the total number of rows deleted.
 */
export async function purgeStaleGuestRateLimitBuckets(
  pool: Pool,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - GUEST_RATE_LIMIT_BUCKET_RETENTION_MS);
  const status = await pool.query(
    `DELETE FROM guest_status_rate_limit_buckets WHERE bucket_key IN (
       SELECT bucket_key FROM guest_status_rate_limit_buckets
        WHERE window_started_at <= $1
        ORDER BY bucket_key LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    [cutoff, PURGE_BATCH],
  );
  const push = await pool.query(
    `DELETE FROM guest_push_rate_limit_buckets WHERE bucket_key IN (
       SELECT bucket_key FROM guest_push_rate_limit_buckets
        WHERE window_started_at <= $1
        ORDER BY bucket_key LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    [cutoff, PURGE_BATCH],
  );
  return (status.rowCount ?? 0) + (push.rowCount ?? 0);
}
