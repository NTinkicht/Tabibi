import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { GuestAccessRejectedError } from '@/modules/guest-access';
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
const DEFAULT_CREDENTIAL_LOOKUP_LIMIT = 1_200;
const UNTRUSTED_INGRESS_BUCKET = 'guest-status:untrusted-ingress';
const CREDENTIAL_LOOKUP_BUCKET = 'guest-status:credential-lookup-fuse';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function credentialIdForRateLimit(bearer: string): string | null {
  const separator = bearer.indexOf('.');
  if (separator <= 0) return null;
  const credentialId = bearer.slice(0, separator);
  return UUID_PATTERN.test(credentialId) ? credentialId.toLowerCase() : null;
}

function credentialLookupLimit(): number {
  const configured = Number(process.env.GUEST_STATUS_CREDENTIAL_LOOKUP_LIMIT);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_CREDENTIAL_LOOKUP_LIMIT;
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
 * Apply shared throttling without trusting caller-controlled forwarding headers.
 * Malformed identifiers take the small untrusted bucket immediately. Valid-format
 * identifiers first pass a high-capacity deployment safety fuse before any
 * credential lookup, which bounds database work even when attackers rotate UUIDs.
 * Only IDs that actually exist may then select a credential-specific polling bucket.
 */
async function withinRateLimit(
  pool: Pool,
  bearer: string | null,
): Promise<boolean> {
  const credentialId = bearer ? credentialIdForRateLimit(bearer) : null;
  if (!credentialId) {
    return consumeBucket(
      pool,
      UNTRUSTED_INGRESS_BUCKET,
      UNTRUSTED_INGRESS_LIMIT,
    );
  }

  if (
    !(await consumeBucket(
      pool,
      CREDENTIAL_LOOKUP_BUCKET,
      credentialLookupLimit(),
    ))
  ) {
    return false;
  }

  const knownCredential = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM guest_credentials WHERE id=$1) AS exists',
    [credentialId],
  );
  if (knownCredential.rows[0]?.exists === true) {
    return consumeBucket(pool, `credential:${credentialId}`, CREDENTIAL_LIMIT);
  }
  return consumeBucket(
    pool,
    UNTRUSTED_INGRESS_BUCKET,
    UNTRUSTED_INGRESS_LIMIT,
  );
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
    return Response.json(snapshot, { status: 200, headers: SECURITY_HEADERS });
  } catch (error) {
    const rejected = error instanceof GuestAccessRejectedError;
    if (!rejected) getLogger().error('guest status read failed');
    return Response.json(
      { error: 'Guest access rejected' },
      { status: rejected ? 401 : 500, headers: SECURITY_HEADERS },
    );
  }
}
