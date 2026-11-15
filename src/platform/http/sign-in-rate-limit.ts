import { createHash } from 'node:crypto';
import { getPool } from '@/platform/database/pool';

// Fixed-window attempt budget shared by sign-in style routes. Buckets live in
// staff_sign_in_rate_limit_buckets; callers namespace their keys.
export const SIGN_IN_RATE_WINDOW_SECONDS = 15 * 60;

export function keyDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export async function consumeSignInBudget(
  key: string,
  limit: number,
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
    [key, limit, SIGN_IN_RATE_WINDOW_SECONDS],
  );
  return result.rows[0]?.allowed === true;
}
