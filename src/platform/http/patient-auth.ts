import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { getPool } from '@/platform/database/pool';
import { StaffAuthenticationError } from './staff-auth';

// TAB-P1-01 slice 2: patient sessions. They mirror the staff session design
// (signed token, server-side revocable row holding only a verifier) but use a
// separate table, a separate cookie and a domain-separated signing key derived
// from STAFF_SESSION_SECRET, so a staff token never verifies as a patient
// token and the reverse. Unauthenticated callers get the shared 401 shape.

const PATIENT_SESSION_COOKIE = 'tabibi_patient_session';
const KEY_CONTEXT = 'tabibi:patient-session:v1';

interface PatientClaims {
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

function signingKey(): Buffer {
  const secret = process.env.STAFF_SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('STAFF_SESSION_SECRET must contain at least 32 characters');
  return createHmac('sha256', secret).update(KEY_CONTEXT).digest();
}

function sessionVerifier(sid: string): Buffer {
  return createHash('sha256').update(sid).digest();
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

export async function createPatientSessionToken(
  userId: string,
  expiresAt: Date,
  db: Queryable = getPool(),
): Promise<string> {
  signingKey();
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const sid = randomBytes(32).toString('base64url');
  const issued = await db.query<{ user_id: string }>(
    `INSERT INTO patient_sessions (verifier, user_id, expires_at)
     VALUES ($1, $2, to_timestamp($3))
     RETURNING user_id`,
    [sessionVerifier(sid), userId, exp],
  );
  if (!issued.rows[0]) throw new Error('Unknown patient account');
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, sid, exp }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function decode(value: string): PatientClaims | null {
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [payload, supplied] = parts;
  if (!payload || !supplied) return null;
  const left = Buffer.from(supplied);
  const right = Buffer.from(sign(payload));
  if (left.length !== right.length || !timingSafeEqual(left, right))
    return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return null;
  const { sub, sid, exp } = parsed as Record<string, unknown>;
  const valid =
    typeof sub === 'string' &&
    sub.length > 0 &&
    typeof sid === 'string' &&
    sid.length > 0 &&
    typeof exp === 'number' &&
    Number.isSafeInteger(exp) &&
    exp > Date.now() / 1000;
  return valid ? { sub, sid, exp } : null;
}

// Exactly one cookie with this name is accepted; duplicates are ambiguous.
function patientSessionCookie(request: Request): string | null {
  const values = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${PATIENT_SESSION_COOKIE}=`))
    .map((part) => part.slice(PATIENT_SESSION_COOKIE.length + 1));
  return values.length === 1 && values[0] ? values[0] : null;
}

export interface AuthenticatedPatient {
  userId: string;
  displayName: string;
}

export async function authenticatedPatient(
  request: Request,
): Promise<AuthenticatedPatient> {
  const cookie = patientSessionCookie(request);
  const claims = cookie ? decode(cookie) : null;
  if (!claims) throw new StaffAuthenticationError();
  const found = await getPool().query<{ id: string; display_name: string }>(
    `SELECT u.id, u.display_name
       FROM patient_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.verifier = $1 AND s.user_id::text = $2
        AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.auth_subject LIKE 'patient:%'`,
    [sessionVerifier(claims.sid), claims.sub],
  );
  const row = found.rows[0];
  if (!row) throw new StaffAuthenticationError();
  return { userId: row.id, displayName: row.display_name };
}

// Idempotent: a missing, malformed or already revoked session is a no-op.
export async function revokePatientSession(request: Request): Promise<void> {
  const cookie = patientSessionCookie(request);
  const claims = cookie ? decode(cookie) : null;
  if (!claims) return;
  await getPool().query(
    `UPDATE patient_sessions SET revoked_at = now()
      WHERE verifier = $1 AND user_id::text = $2 AND revoked_at IS NULL`,
    [sessionVerifier(claims.sid), claims.sub],
  );
}

export function patientSessionSetCookie(
  token: string,
  maxAgeSeconds: number,
): string {
  return `${PATIENT_SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(maxAgeSeconds)}; HttpOnly; Secure; SameSite=Strict`;
}

export const CLEARED_PATIENT_SESSION_COOKIE = `${PATIENT_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
