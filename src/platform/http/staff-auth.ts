import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPool } from '@/platform/database/pool';
import type { ClinicScope } from '@/modules/identity';

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
  const [payload, supplied] = value.split('.');
  if (!payload || !supplied) return null;
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right))
    return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as StaffClaims;
    return typeof claims.sub === 'string' && claims.exp > Date.now() / 1000
      ? claims
      : null;
  } catch {
    return null;
  }
}

export async function authenticatedClinicScope(
  request: Request,
  clinicId: string,
): Promise<ClinicScope> {
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('tabibi_staff_session='))
    ?.slice('tabibi_staff_session='.length);
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
  if (!origin || origin !== new URL(request.url).origin)
    throw new StaffCsrfError();
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
