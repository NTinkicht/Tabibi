import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  authenticatedGuestCredentialId,
  GuestAccessRejectedError,
} from '@/modules/guest-access';
import {
  GuestStatusService,
  type GuestQueueStatusSnapshot,
} from '@/modules/guest-status';
import { getPool } from '@/platform/database/pool';
import { getLogger } from '@/platform/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STREAM_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'text/event-stream; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  connection: 'keep-alive',
};
const REJECT_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
const RATE_WINDOW_MS = 60_000;
const UNTRUSTED_INGRESS_LIMIT = 6;
const CREDENTIAL_CONNECT_LIMIT = 3;
const UNTRUSTED_INGRESS_BUCKET = 'guest-status-stream:untrusted-ingress';
const STREAM_INTERVAL_MS = 15_000;
const MAX_STREAM_TICKS = 8;

/** Extract the HttpOnly guest bearer from the request cookie header. */
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

/** Atomically consume one bounded connection-rate bucket. */
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

/** Apply the shared ingress bucket or the authenticated credential bucket. */
async function withinConnectionRateLimit(
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

  return consumeBucket(
    pool,
    `guest-status-stream:credential:${credentialId}`,
    CREDENTIAL_CONNECT_LIMIT,
  );
}

/** Wait for the next bounded refresh tick, stopping immediately on abort. */
function waitForNextTick(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, STREAM_INTERVAL_MS);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Encode one guest-safe status snapshot as an SSE status event. */
function encodeStatusEvent(snapshot: GuestQueueStatusSnapshot): Uint8Array {
  return new TextEncoder().encode(
    `event: status\ndata: ${JSON.stringify(snapshot)}\n\n`,
  );
}

/** Build a stable state identity that deliberately excludes generatedAt. */
function snapshotVersion(snapshot: GuestQueueStatusSnapshot): string {
  if (snapshot.terminal) return `terminal:${snapshot.finalStatus}`;
  return [
    snapshot.target.clinicId,
    snapshot.target.sessionId,
    snapshot.target.queueEntryId,
    snapshot.queueState,
    snapshot.session.status,
    snapshot.session.queueOrderVersion,
    snapshot.session.delayVersion,
  ].join(':');
}

/** Serve a bounded, change-driven, credential-safe guest status event stream. */
export async function GET(request: Request): Promise<Response> {
  const bearer = guestBearer(request);
  let pool: Pool;
  let initialSnapshot: GuestQueueStatusSnapshot;

  try {
    pool = getPool();

    if (!(await withinConnectionRateLimit(pool, bearer))) {
      return Response.json(
        { error: 'Too many requests' },
        {
          status: 429,
          headers: { ...REJECT_HEADERS, 'retry-after': '60' },
        },
      );
    }

    if (!bearer) {
      return Response.json(
        { error: 'Guest access rejected' },
        { status: 401, headers: REJECT_HEADERS },
      );
    }

    initialSnapshot = await new GuestStatusService(pool).getSnapshot(bearer);
  } catch (error) {
    const rejected = error instanceof GuestAccessRejectedError;
    if (!rejected) getLogger().error('guest status stream bootstrap failed');
    return Response.json(
      { error: 'Guest access rejected' },
      { status: rejected ? 401 : 500, headers: REJECT_HEADERS },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const statusService = new GuestStatusService(pool);
      let lastVersion = snapshotVersion(initialSnapshot);
      controller.enqueue(encodeStatusEvent(initialSnapshot));

      if (initialSnapshot.terminal) {
        controller.close();
        return;
      }

      for (let tick = 1; tick < MAX_STREAM_TICKS; tick += 1) {
        if (!(await waitForNextTick(request.signal))) break;

        try {
          const snapshot = await statusService.getSnapshot(bearer);
          const nextVersion = snapshotVersion(snapshot);
          if (nextVersion !== lastVersion) {
            controller.enqueue(encodeStatusEvent(snapshot));
            lastVersion = nextVersion;
          }

          if (snapshot.terminal) break;
        } catch (error) {
          if (!(error instanceof GuestAccessRejectedError)) {
            getLogger().error('guest status stream refresh failed');
          }
          break;
        }
      }

      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: STREAM_HEADERS,
  });
}
