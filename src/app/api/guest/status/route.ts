import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  authenticatedGuestCredentialId,
  GuestAccessRejectedError,
} from '@/modules/guest-access';
import { GuestStatusService } from '@/modules/guest-status';
import { getPool } from '@/platform/database/pool';
import { getLogger } from '@/platform/observability/logger';

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
const RATE_WINDOW_MS = 60_000;
const UNTRUSTED_INGRESS_LIMIT = 6;
const CREDENTIAL_LIMIT = 6;
const UNTRUSTED_INGRESS_BUCKET = 'guest-status:untrusted-ingress';

function guestBearer(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name === '__Host-tabibi_guest') {
      const value = valueParts.join('=');
      return value || null;
    }
  }
  return null;
}

async function consumeBucket(
  pool: Pool,
  key: string,
  limit: number,
): Promise<boolean> {
  const bucketKey = createHash('sha256').update(key).digest('hex');
  const result = await pool.query<{ allowed: boolean }>(
    `WITH cleanup AS (
       DELETE FROM guest_status_rate_limit_buckets
        WHERE bucket_key <> $1
          AND window_started_at < now() - ($3::bigint * interval '1 millisecond')
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
    [bucketKey, limit, RATE_WINDOW_MS],
  );
  return result.rows[0]?.allowed === true;
}

/**
 * Apply deployment-wide throttling without trusting caller-controlled forwarding
 * headers. Only a bearer envelope authenticated by the server signing secret may
 * select a credential-specific bucket. Malformed or forged envelopes are bounded
 * by the shared untrusted bucket before any credential database lookup occurs.
 */
async function withinRateLimit(
  pool: Pool,
  bearer: string | null,
): Promise<boolean> {
  const credentialId = bearer ? authenticatedGuestCredentialId(bearer) : null;
  if (!credentialId) {
    return consumeBucket(
      pool,
      UNTRUSTED_INGRESS_BUCKET,
      UNTRUSTED_INGRESS_LIMIT,
    );
  }
  return consumeBucket(pool, `credential:${credentialId}`, CREDENTIAL_LIMIT);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const bearer = guestBearer(request);
    const pool = getPool();
    if (!(await withinRateLimit(pool, bearer))) {
      return Response.json(
        { error: 'Too many requests' },
        { status: 429, headers: { ...SECURITY_HEADERS, 'retry-after': '60' } },
      );
    }
    if (!bearer) throw new GuestAccessRejectedError();
    const snapshot = await new GuestStatusService(pool).getSnapshot(bearer);
    return Response.json(snapshot, {
      status: 200,
      headers: SECURITY_HEADERS,
    });
  } catch (error) {
    const rejected = error instanceof GuestAccessRejectedError;
    if (!rejected) getLogger().error('guest status read failed');
    return Response.json(
      { error: 'Guest access rejected' },
      { status: rejected ? 401 : 500, headers: SECURITY_HEADERS },
    );
  }
}
