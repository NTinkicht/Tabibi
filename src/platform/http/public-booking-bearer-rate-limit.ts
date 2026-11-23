import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { authenticatedGuestCredentialId } from '@/modules/guest-access';

// TAB-P0-15 abuse control for the booking-origin, Authorization-header-only
// guest routes (status, live-queue-status, check-in, cancel). A one-minute
// fixed window keyed by the digest of the credential id that the server signing
// secret authenticated; no caller-controlled header (such as a forwarded
// address) selects a bucket. A missing, malformed or forged bearer shares one
// small per-route bucket that is consulted before any database credential
// lookup, so it can never consume a real guest's budget. Buckets share
// guest_status_rate_limit_buckets, whose 60 second window and retention sweep
// already match, under a namespaced key.
export const PUBLIC_BOOKING_BEARER_WINDOW_MS = 60_000;
export const PUBLIC_BOOKING_BEARER_RETRY_AFTER_SECONDS = 60;
export const PUBLIC_BOOKING_BEARER_UNTRUSTED_LIMIT = 6;

export type PublicBookingBearerScope =
  | 'status'
  | 'live-queue-status'
  | 'check-in'
  | 'cancel';

// Polling reads allow the 30 second poll plus stream-hint refreshes; the
// mutations are deliberate single actions with idempotent retries.
export const PUBLIC_BOOKING_BEARER_CREDENTIAL_LIMITS: Readonly<
  Record<PublicBookingBearerScope, number>
> = {
  status: 12,
  'live-queue-status': 12,
  'check-in': 6,
  cancel: 6,
};

/** Returns false when the applicable one-minute budget is exhausted. */
export async function withinPublicBookingBearerBudget(
  pool: Pool,
  scope: PublicBookingBearerScope,
  bearer: string | null,
): Promise<boolean> {
  const credentialId = bearer ? authenticatedGuestCredentialId(bearer) : null;
  const key = credentialId
    ? `public-booking-bearer:${scope}:credential:${credentialId}`
    : `public-booking-bearer:${scope}:untrusted`;
  const limit = credentialId
    ? PUBLIC_BOOKING_BEARER_CREDENTIAL_LIMITS[scope]
    : PUBLIC_BOOKING_BEARER_UNTRUSTED_LIMIT;
  const bucketKey = createHash('sha256').update(key).digest('hex');
  const result = await pool.query<{ allowed: boolean }>(
    `WITH upserted AS (
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
             updated_at = now()
         WHERE guest_status_rate_limit_buckets.window_started_at < now() - ($3::bigint * interval '1 millisecond')
            OR guest_status_rate_limit_buckets.request_count < $2
       RETURNING true AS allowed
     )
     SELECT EXISTS(SELECT 1 FROM upserted) AS allowed`,
    [bucketKey, limit, PUBLIC_BOOKING_BEARER_WINDOW_MS],
  );
  return result.rows[0]?.allowed === true;
}

export function bookingBearerRateLimited(requestId?: string): {
  body: unknown;
  status: number;
} {
  return {
    body: requestId
      ? { status: 'rejected', error: 'rate_limited', requestId }
      : { error: 'rate_limited' },
    status: 429,
  };
}
