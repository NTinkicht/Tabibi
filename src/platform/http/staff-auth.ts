import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPool } from '@/platform/database/pool';
import type { ClinicScope } from '@/modules/identity';

const STAFF_SESSION_COOKIE = 'tabibi_staff_session';

interface StaffClaims {
  sub: string;
  exp: number;
}

export function createStaffSessionToken(
  authSubject: string,
  expiresAt: Date,
): string {
  const secret = process.env.STAFF_SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('STAFF_SESSION_SECRET must contain at least 32 characters');
  const payload = Buffer.from(
    JSON.stringify({
      sub: authSubject,
      exp: Math.floor(expiresAt.getTime() / 1000),
    }),
  ).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function decode(value: string): StaffClaims | null {
  const secret = process.env.STAFF_SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('STAFF_SESSION_SECRET must contain at least 32 characters');
  // A staff bearer has exactly one separator. Ignoring extra segments would
  // accept malformed aliases of a valid HMAC-signed session token.
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [payload, supplied] = parts;
  if (!payload || !supplied) return null;
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right))
    return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  return validClaims(parsed) ? parsed : null;
}

// Claims are checked by exact type, never by JavaScript coercion: a string,
// array or fractional `exp` and an empty `sub` are malformed even when signed.
function validClaims(value: unknown): value is StaffClaims {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const { sub, exp } = value as Record<string, unknown>;
  return (
    typeof sub === 'string' &&
    sub.length > 0 &&
    typeof exp === 'number' &&
    Number.isSafeInteger(exp) &&
    exp > Date.now() / 1000
  );
}

// Exactly one session cookie is accepted. Several cookies with this name
// (for example one planted from a sibling subdomain with a narrower path,
// which browsers send first) are ambiguous and fail closed.
function staffSessionCookie(request: Request): string | null {
  const values = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${STAFF_SESSION_COOKIE}=`))
    .map((part) => part.slice(STAFF_SESSION_COOKIE.length + 1));
  return values.length === 1 && values[0] ? values[0] : null;
}

export async function authenticatedClinicScope(
  request: Request,
  clinicId: string,
): Promise<ClinicScope> {
  const cookie = staffSessionCookie(request);
  const claims = cookie ? decode(cookie) : null;
  if (!claims) throw new StaffAuthenticationError();
  const user = await getPool().query<{ id: string }>(
    'SELECT id FROM users WHERE auth_subject = $1',
    [claims.sub],
  );
  if (!user.rows[0]) throw new StaffAuthenticationError();
  return { clinicId, actorUserId: user.rows[0].id };
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin) throw new StaffCsrfError();

  let suppliedOrigin: URL;
  try {
    suppliedOrigin = new URL(origin);
  } catch {
    throw new StaffCsrfError();
  }

  const requestUrl = new URL(request.url);
  const receivedHost = request.headers.get('host');
  const expectedHosts = new Set([requestUrl.host]);
  if (receivedHost) expectedHosts.add(receivedHost);

  if (
    suppliedOrigin.protocol !== requestUrl.protocol ||
    !expectedHosts.has(suppliedOrigin.host)
  ) {
    throw new StaffCsrfError();
  }
}

export class StaffAuthenticationError extends Error {
  constructor() {
    super('Authentication required');
    this.name = 'StaffAuthenticationError';
  }
}
export class StaffCsrfError extends Error {
  constructor() {
    super('Same-origin mutation required');
    this.name = 'StaffCsrfError';
  }
}
