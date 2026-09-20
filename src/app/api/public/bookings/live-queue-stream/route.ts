import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  PublicGuestLiveQueueStatusRejectedError,
  PublicGuestLiveQueueStatusService,
  type PublicGuestLiveQueueStatusResult,
} from '@/modules/public-guest-live-queue-status';
import { authenticatedGuestCredentialId } from '@/modules/guest-access';
import { getPool } from '@/platform/database/pool';
import { getLogger } from '@/platform/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STREAM_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'text/event-stream; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  connection: 'keep-alive',
};
const REJECT_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};
const RATE_WINDOW_MS = 60_000;
const CREDENTIAL_CONNECT_LIMIT = 3;
const UNTRUSTED_INGRESS_LIMIT = 6;
const STREAM_INTERVAL_MS = 5_000;
const MAX_STREAM_TICKS = 24;

function bearerFrom(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const bearer = authorization.slice('Bearer '.length).trim();
  return bearer.length > 0 && bearer.length <= 4096 ? bearer : null;
}

async function consumeBucket(pool: Pool, key: string, limit: number) {
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
               WHEN guest_status_rate_limit_buckets.window_started_at < now() - ($3::bigint * interval '1 millisecond') THEN now()
               ELSE guest_status_rate_limit_buckets.window_started_at END,
             request_count = CASE
               WHEN guest_status_rate_limit_buckets.window_started_at < now() - ($3::bigint * interval '1 millisecond') THEN 1
               ELSE guest_status_rate_limit_buckets.request_count + 1 END,
             updated_at = now()
         WHERE guest_status_rate_limit_buckets.window_started_at < now() - ($3::bigint * interval '1 millisecond')
            OR guest_status_rate_limit_buckets.request_count < $2
       RETURNING true AS allowed
     ) SELECT EXISTS(SELECT 1 FROM upserted) AS allowed`,
    [bucketKey, limit, RATE_WINDOW_MS],
  );
  return result.rows[0]?.allowed === true;
}

function wait(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(true);
    }, STREAM_INTERVAL_MS);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function version(snapshot: PublicGuestLiveQueueStatusResult): string {
  return JSON.stringify(snapshot);
}

/** A content-free hint: clients must fetch the authoritative snapshot. */
export function encodeChangeHint(): Uint8Array {
  return new TextEncoder().encode('event: change\ndata: {}\n\n');
}

export async function GET(request: Request): Promise<Response> {
  const bearer = bearerFrom(request);
  const credentialId = bearer ? authenticatedGuestCredentialId(bearer) : null;
  let pool: Pool;
  let initial: PublicGuestLiveQueueStatusResult;

  try {
    pool = getPool();
    const bucket = credentialId
      ? `public-live-queue-stream:credential:${credentialId}`
      : 'public-live-queue-stream:untrusted';
    const allowed = await consumeBucket(
      pool,
      bucket,
      credentialId ? CREDENTIAL_CONNECT_LIMIT : UNTRUSTED_INGRESS_LIMIT,
    );
    if (!allowed) {
      return Response.json(
        { status: 'rejected' },
        {
          status: 429,
          headers: { ...REJECT_HEADERS, 'retry-after': '60' },
        },
      );
    }
    if (!bearer || !credentialId) {
      return Response.json(
        { status: 'rejected' },
        { status: 400, headers: REJECT_HEADERS },
      );
    }
    initial = await new PublicGuestLiveQueueStatusService(pool).get(
      bearer,
      request.signal,
    );
  } catch (error) {
    const rejected = error instanceof PublicGuestLiveQueueStatusRejectedError;
    if (!rejected && !request.signal.aborted) {
      getLogger().error('public guest live queue stream bootstrap failed');
    }
    return Response.json(
      { status: 'rejected' },
      {
        status: rejected ? 400 : 500,
        headers: REJECT_HEADERS,
      },
    );
  }

  // Fetch streaming cancellation is not guaranteed to propagate through
  // request.signal on every deployment. Reader cancellation must also
  // promptly stop pending timers, DB queries and further enqueue attempts.
  const streamAbort = new AbortController();
  let readerCancelled = false;
  const abortFromRequest = () => streamAbort.abort();
  request.signal.addEventListener('abort', abortFromRequest, { once: true });
  if (request.signal.aborted) streamAbort.abort();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const service = new PublicGuestLiveQueueStatusService(pool);
      let lastVersion = version(initial);
      try {
        for (let tick = 1; tick < MAX_STREAM_TICKS; tick += 1) {
          if (!(await wait(streamAbort.signal))) break;
          try {
            const next = await service.get(bearer, streamAbort.signal);
            if (streamAbort.signal.aborted) break;
            const nextVersion = version(next);
            if (nextVersion !== lastVersion) {
              controller.enqueue(encodeChangeHint());
              lastVersion = nextVersion;
            }
          } catch (error) {
            if (
              !streamAbort.signal.aborted &&
              !(error instanceof PublicGuestLiveQueueStatusRejectedError)
            ) {
              getLogger().error('public guest live queue stream refresh failed');
            }
            break;
          }
        }
      } finally {
        request.signal.removeEventListener('abort', abortFromRequest);
        if (!readerCancelled) controller.close();
      }
    },
    cancel() {
      readerCancelled = true;
      streamAbort.abort();
      request.signal.removeEventListener('abort', abortFromRequest);
    },
  });
  return new Response(stream, { status: 200, headers: STREAM_HEADERS });
}
