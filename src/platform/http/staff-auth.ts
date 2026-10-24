import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { getPool } from '@/platform/database/pool';
import type { ClinicScope } from '@/modules/identity';

const STAFF_SESSION_COOKIE = 'tabibi_staff_session';

interface StaffClaims {
  sub: string;
  sid: string;
  exp: number;
}

interface Queryable {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

function signingSecret(): string {
  const secret = process.env.STAFF_SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('STAFF_SESSION_SECRET must contain at least 32 characters');
  return secret;
}

// Only a SHA-256 verifier of the session identifier is persisted, never the
// identifier or the signed token, so a database read alone cannot mint or
// replay a staff session (TAB-P0-01, owner decision A on #634).
function sessionVerifier(sid: string): Buffer {
  return createHash('sha256').update(sid).digest();
}

// Issues a server-revocable staff session for an existing user and returns
// its signed token. Fails when the subject is unknown (and, through the table
// CHECK, when the expiry is not after issuance), so no token is ever signed
// without a matching session row.
export async function createStaffSessionToken(
  authSubject: string,
  expiresAt: Date,
  db: Queryable = getPool(),
): Promise<string> {
  const secret = signingSecret();
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const sid = randomBytes(32).toString('base64url');
  const issued = await db.query<{ user_id: string }>(
    `INSERT INTO staff_sessions (verifier, user_id, expires_at)
     SELECT $1, id, to_timestamp($3) FROM users WHERE auth_subject = $2
     RETURNING user_id`,
    [sessionVerifier(sid), authSubject, exp],
  );
  if (!issued.rows[0]) throw new Error('Unknown staff subject');
  const payload = Buffer.from(
    JSON.stringify({ sub: authSubject, sid, exp }),
  ).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function decode(value: string): StaffClaims | null {
  const secret = signingSecret();
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
// array or fractional `exp`, an empty `sub` and a missing or empty `sid` are
// malformed even when signed (pre-revocation `{sub, exp}` tokens included).
function validClaims(value: unknown): value is StaffClaims {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const { sub, sid, exp } = value as Record<string, unknown>;
  return (
    typeof sub === 'string' &&
    sub.length > 0 &&
    typeof sid === 'string' &&
    sid.length > 0 &&
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
  // The session must exist, belong to the signed subject, be unrevoked and
  // unexpired server-side: a revoked or unknown `sid` fails closed.
  const user = await getPool().query<{ id: string }>(
    `SELECT u.id FROM staff_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.verifier = $1 AND u.auth_subject = $2
       AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sessionVerifier(claims.sid), claims.sub],
  );
  if (!user.rows[0]) throw new StaffAuthenticationError();
  return { clinicId, actorUserId: user.rows[0].id };
}

// Revokes the session carried by the request's single valid cookie, if any.
// The revocation is bound to the signed subject, so a token can only ever
// revoke its own session. Missing, malformed or already revoked sessions are
// a no-op: logout is idempotent and reveals nothing about other sessions.
export async function revokeStaffSession(request: Request): Promise<void> {
  const cookie = staffSessionCookie(request);
  const claims = cookie ? decode(cookie) : null;
  if (!claims) return;
  await getPool().query(
    `UPDATE staff_sessions s SET revoked_at = now()
     FROM users u
     WHERE u.id = s.user_id AND s.verifier = $1 AND u.auth_subject = $2
       AND s.revoked_at IS NULL`,
    [sessionVerifier(claims.sid), claims.sub],
  );
}

export const CLEARED_STAFF_SESSION_COOKIE = `${STAFF_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

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
