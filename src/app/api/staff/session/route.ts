import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verifyStaffPassword } from '@/modules/identity/staff-credentials';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  StaffAuthenticationError,
  createStaffSessionToken,
  requireSameOrigin,
  revokeStaffSession,
  staffSessionSetCookie,
} from '@/platform/http/staff-auth';

// TAB-P0-01 (#725): staff sign-in. Same-origin is enforced first, the body is
// size-bounded and strictly validated, and unknown user, wrong password and
// locked account all return the one 401 shape from the credential service.
const MAX_BODY_BYTES = 4096;
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;
const MIN_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const RATE_WINDOW_SECONDS = 15 * 60;
const ACCOUNT_LIMIT = 10;
const SOURCE_LIMIT = 40;

const bodySchema = z
  .object({
    subject: z.string().min(1).max(320),
    password: z.string().min(1).max(1024),
  })
  .strict();

class BodyTooLargeError extends SyntaxError {}

function sessionTtlSeconds(): number {
  const raw = Number(process.env.STAFF_SESSION_TTL_SECONDS);
  if (!Number.isInteger(raw)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, raw));
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new BodyTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('Missing body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Every malformed-input path yields the same generic 400: parser and schema
// messages can echo fragments of the body (including the password).
async function parseBody(
  request: Request,
): Promise<z.infer<typeof bodySchema>> {
  try {
    return bodySchema.parse(await readBoundedJson(request));
  } catch {
    throw new z.ZodError([
      { code: 'custom', path: [], message: 'Invalid sign-in request' },
    ]);
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function sourceOf(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return (
    forwarded?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

async function consume(key: string, limit: number): Promise<boolean> {
  const result = await getPool().query<{ allowed: boolean }>(
    `WITH upserted AS (
       INSERT INTO guest_status_rate_limit_buckets
         (bucket_key, window_started_at, request_count, updated_at)
       VALUES ($1, now(), 1, now())
       ON CONFLICT (bucket_key) DO UPDATE
         SET window_started_at = CASE
               WHEN guest_status_rate_limit_buckets.window_started_at < now() - ($3::int * interval '1 second')
                 THEN now() ELSE guest_status_rate_limit_buckets.window_started_at END,
             request_count = CASE
               WHEN guest_status_rate_limit_buckets.window_started_at < now() - ($3::int * interval '1 second')
                 THEN 1 ELSE guest_status_rate_limit_buckets.request_count + 1 END,
             updated_at = now()
         WHERE guest_status_rate_limit_buckets.window_started_at < now() - ($3::int * interval '1 second')
            OR guest_status_rate_limit_buckets.request_count < $2
       RETURNING true
     )
     SELECT EXISTS(SELECT 1 FROM upserted) AS allowed`,
    [key, limit, RATE_WINDOW_SECONDS],
  );
  return result.rows[0]?.allowed === true;
}

export async function POST(request: Request): Promise<Response> {
  let setCookie: string | null = null;
  let rateLimited = false;
  const response = await operationalJson(request, async () => {
    requireSameOrigin(request);
    const body = await parseBody(request);
    const subject = body.subject.normalize('NFKC');
    const withinSource = await consume(
      `staff-signin:source:${digest(sourceOf(request))}`,
      SOURCE_LIMIT,
    );
    const withinAccount = await consume(
      `staff-signin:account:${digest(subject)}`,
      ACCOUNT_LIMIT,
    );
    if (!withinSource || !withinAccount) {
      rateLimited = true;
      return { status: 429, body: { error: 'rate_limited' } };
    }
    const verified = await verifyStaffPassword(
      getPool(),
      subject,
      body.password,
    );
    if (!verified.ok) throw new StaffAuthenticationError();
    // A new sign-in replaces the session carried by the request (decision A
    // on #725): sessions never silently stack behind a stale cookie.
    await revokeStaffSession(request);
    const ttl = sessionTtlSeconds();
    const token = await createStaffSessionToken(
      subject,
      new Date(Date.now() + ttl * 1000),
    );
    setCookie = staffSessionSetCookie(token, ttl);
    const memberships = await getPool().query<{
      clinic_id: string;
      role: string;
    }>(
      `SELECT clinic_id, role FROM clinic_memberships
        WHERE user_id = $1 ORDER BY clinic_id`,
      [verified.userId],
    );
    return {
      status: 200,
      body: {
        memberships: memberships.rows.map((row) => ({
          clinicId: row.clinic_id,
          role: row.role,
        })),
      },
    };
  });
  if (setCookie && response.status === 200)
    response.headers.append('set-cookie', setCookie);
  if (rateLimited)
    response.headers.set('retry-after', String(RATE_WINDOW_SECONDS));
  return response;
}
