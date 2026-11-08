import { createHash } from 'node:crypto';
import { getPool } from '@/platform/database/pool';

/** Short stable digest for a rate-limit key; never store the raw value. */
export function rateLimitDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * Fixed-window counter shared with staff sign-in (same table, distinct key
 * prefixes). Returns false once `limit` requests were counted in the window.
 */
export async function consumeStaffRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const result = await getPool().query<{ allowed: boolean }>(
    `WITH upserted AS (
       INSERT INTO staff_sign_in_rate_limit_buckets
         (bucket_key, window_started_at, request_count, updated_at)
       VALUES ($1, now(), 1, now())
       ON CONFLICT (bucket_key) DO UPDATE
         SET window_started_at = CASE
               WHEN staff_sign_in_rate_limit_buckets.window_started_at < now() - ($3::int * interval '1 second')
                 THEN now() ELSE staff_sign_in_rate_limit_buckets.window_started_at END,
             request_count = CASE
               WHEN staff_sign_in_rate_limit_buckets.window_started_at < now() - ($3::int * interval '1 second')
                 THEN 1 ELSE staff_sign_in_rate_limit_buckets.request_count + 1 END,
             updated_at = now()
         WHERE staff_sign_in_rate_limit_buckets.window_started_at < now() - ($3::int * interval '1 second')
            OR staff_sign_in_rate_limit_buckets.request_count < $2
       RETURNING true
     )
     SELECT EXISTS(SELECT 1 FROM upserted) AS allowed`,
    [key, limit, windowSeconds],
  );
  return result.rows[0]?.allowed === true;
}
