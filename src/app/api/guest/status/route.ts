import { createHash } from 'node:crypto';
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
const IP_LIMIT = 30;
const CREDENTIAL_LIMIT = 6;
const rateBuckets = new Map<
  string,
  { windowStartedAt: number; count: number }
>();

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

function requestIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
}

function consumeBucket(key: string, limit: number, now: number): boolean {
  const current = rateBuckets.get(key);
  if (!current || now - current.windowStartedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { windowStartedAt: now, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function withinRateLimit(request: Request, bearer: string | null): boolean {
  const now = Date.now();
  const ip = requestIp(request);
  if (!consumeBucket(`ip:${ip}`, IP_LIMIT, now)) return false;
  if (!bearer) return true;
  const credentialKey = createHash('sha256').update(bearer).digest('hex');
  return consumeBucket(`credential:${credentialKey}`, CREDENTIAL_LIMIT, now);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const bearer = guestBearer(request);
    if (!withinRateLimit(request, bearer)) {
      return Response.json(
        { error: 'Too many requests' },
        { status: 429, headers: { ...SECURITY_HEADERS, 'retry-after': '60' } },
      );
    }
    if (!bearer) throw new GuestAccessRejectedError();
    const snapshot = await new GuestStatusService(getPool()).getSnapshot(
      bearer,
    );
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
