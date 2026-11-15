import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

const WINDOW_MS = 60_000;
// Rows are only purged once older than every window in use (the longest is
// the one-hour resend window), so a short-window call never evicts a
// longer-window bucket.
const PURGE_AFTER_MS = 2 * 60 * 60 * 1_000;

/**
 * Fixed-window counter shared with the other guest routes
 * (guest_status_rate_limit_buckets). Keys are hashed, so no credential or
 * endpoint is stored. Returns false when the bucket is exhausted.
 */
export async function consumeGuestPushBucket(
  pool: Pool,
  key: string,
  limit: number,
  windowMs: number = WINDOW_MS,
): Promise<boolean> {
  const bucketKey = createHash('sha256').update(key).digest('hex');
  const result = await pool.query<{ allowed: boolean }>(
    `WITH cleanup AS (
       DELETE FROM guest_status_rate_limit_buckets
        WHERE bucket_key <> $1
          AND window_started_at < now() - ($4::bigint * interval '1 millisecond')
     ), upserted AS (
       INSERT INTO guest_status_rate_limit_buckets
         (bucket_key,window_started_at,request_count,updated_at)
       VALUES ($1,now(),1,now())
       ON CONFLICT (bucket_key) DO UPDATE
         SET window_started_at = CASE
               WHEN guest_status_rate_limit_buckets.window_started_at < now() - ($3::bigint * interval '1 millisecond')
                 THEN now()
               ELSE guest_status_rate_limit_buckets.window_started_at
             END,
             request_count = CASE
               WHEN guest_status_rate_limit_buckets.window_started_at < now() - ($3::bigint * interval '1 millisecond')
                 THEN 1
               ELSE guest_status_rate_limit_buckets.request_count + 1
             END,
             updated_at=now()
         WHERE guest_status_rate_limit_buckets.window_started_at < now() - ($3::bigint * interval '1 millisecond')
            OR guest_status_rate_limit_buckets.request_count < $2
       RETURNING true AS allowed
     )
     SELECT EXISTS(SELECT 1 FROM upserted) AS allowed`,
    [bucketKey, limit, windowMs, PURGE_AFTER_MS],
  );
  return result.rows[0]?.allowed === true;
}
