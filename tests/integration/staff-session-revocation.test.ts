import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { GET as sessionsGet } from '@/app/api/clinics/[clinicId]/sessions/route';
import { POST as logoutPost } from '@/app/api/staff/session/logout/route';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

// TAB-P0-01 (#634, owner decision A): server-revocable staff sessions.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const SECRET = 'staff-session-revocation-secret-at-least-32-chars';
const COOKIE = 'tabibi_staff_session';
const ids = {
  clinic: randomUUID(),
  alice: randomUUID(),
  bob: randomUUID(),
  session: randomUUID(),
  appointment: randomUUID(),
  entry: randomUUID(),
};
const ROUTES_ROOT = join(
  __dirname,
  '..',
  '..',
  'src',
  'app',
  'api',
  'clinics',
  '[clinicId]',
);
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Handler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === 'route.ts' ? [path] : [];
  });
}

function claimsOf(token: string): { sub: string; sid: string; exp: number } {
  return JSON.parse(
    Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
  ) as { sub: string; sid: string; exp: number };
}

function sign(claims: object): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
}

function issue(subject: string, ttlMs = 60_000): Promise<string> {
  return createStaffSessionToken(subject, new Date(Date.now() + ttlMs));
}

function listSessions(token: string): Promise<Response> {
  return sessionsGet(
    new Request(
      `http://localhost/api/clinics/${ids.clinic}/sessions?date=2026-10-24`,
      { headers: { cookie: `${COOKIE}=${token}` } },
    ),
    { params: Promise.resolve({ clinicId: ids.clinic }) },
  );
}

function logout(token: string | null, origin = 'http://localhost') {
  const headers = new Headers({ origin });
  if (token !== null) headers.set('cookie', `${COOKIE}=${token}`);
  return logoutPost(
    new Request('http://localhost/api/staff/session/logout', {
      method: 'POST',
      headers,
    }),
  );
}

async function revokedAt(token: string): Promise<Date | null | undefined> {
  const verifier = createHash('sha256').update(claimsOf(token).sid).digest();
  const row = await pool.query<{ revoked_at: Date | null }>(
    'SELECT revoked_at FROM staff_sessions WHERE verifier = $1',
    [verifier],
  );
  return row.rows[0]?.revoked_at;
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET = SECRET;
  await migrate();
});

beforeEach(async () => {
  await pool.query('TRUNCATE clinic_memberships, clinics, users CASCADE');
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'revocation-alice','Alice'),($2,'revocation-bob','Bob')`,
    [ids.alice, ids.bob],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'revocation-clinic','Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
      ($1,$2,'receptionist'),($1,$3,'receptionist')`,
    [ids.clinic, ids.alice, ids.bob],
  );
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('staff session issuance', () => {
  it('stores only a SHA-256 verifier of the session identifier', async () => {
    const token = await issue('revocation-alice');
    const { sid } = claimsOf(token);
    const rows = await pool.query<{ verifier: Buffer; user_id: string }>(
      'SELECT verifier, user_id FROM staff_sessions',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.user_id).toBe(ids.alice);
    expect(rows.rows[0]?.verifier).toEqual(
      createHash('sha256').update(sid).digest(),
    );
    const dump = JSON.stringify(
      (await pool.query('SELECT * FROM staff_sessions')).rows,
    );
    expect(dump).not.toContain(sid);
    expect(dump).not.toContain(token.split('.')[1]);
  });

  it('refuses to issue a session for an unknown subject', async () => {
    await expect(issue('revocation-nobody')).rejects.toThrow(
      'Unknown staff subject',
    );
    const count = await pool.query('SELECT 1 FROM staff_sessions');
    expect(count.rows).toHaveLength(0);
  });
});

describe('staff logout', () => {
  it('revokes the session: the old token is rejected on every staff route', async () => {
    const token = await issue('revocation-alice');
    expect((await listSessions(token)).status).toBe(200);

    const response = await logout(token);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBe(
      `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    );
    expect(await response.json()).toEqual({ loggedOut: true });
    expect(await revokedAt(token)).toBeInstanceOf(Date);

    const files = routeFiles(ROUTES_ROOT);
    let checked = 0;
    for (const file of files) {
      const routeModule = (await import(file)) as Record<string, unknown>;
      for (const method of METHODS) {
        const handler = routeModule[method] as Handler | undefined;
        if (typeof handler !== 'function') continue;
        const result = await handler(
          new Request(
            `http://localhost/api/clinics/${ids.clinic}/x?date=2026-10-24`,
            {
              method,
              headers: {
                origin: 'http://localhost',
                cookie: `${COOKIE}=${token}`,
                'content-type': 'application/json',
                'idempotency-key': 'revoked-session',
              },
              ...(method === 'GET' ? {} : { body: '{}' }),
            },
          ),
          {
            params: Promise.resolve({
              clinicId: ids.clinic,
              sessionId: ids.session,
              appointmentId: ids.appointment,
              entryId: ids.entry,
            }),
          },
        );
        expect(result.status, `${method} ${file}`).toBe(401);
        checked += 1;
      }
    }
    // Same inventory as tests/api/staff-route-boundary-matrix.test.ts.
    expect(checked).toBe(33);
  });

  it('treats a replayed revoked token as an idempotent no-op that stays rejected', async () => {
    const token = await issue('revocation-alice');
    expect((await logout(token)).status).toBe(200);
    const first = await revokedAt(token);
    expect((await logout(token)).status).toBe(200);
    expect(await revokedAt(token)).toEqual(first);
    expect((await listSessions(token)).status).toBe(401);
  });

  it('revokes only the presented session, never another user or session', async () => {
    const alice = await issue('revocation-alice');
    const aliceOther = await issue('revocation-alice');
    const bob = await issue('revocation-bob');
    expect((await logout(bob)).status).toBe(200);
    expect((await listSessions(bob)).status).toBe(401);
    expect((await listSessions(alice)).status).toBe(200);

    // A signed token naming Bob but carrying Alice's session identifier can
    // neither revoke nor use Alice's session.
    const mixed = sign({ ...claimsOf(alice), sub: 'revocation-bob' });
    expect((await logout(mixed)).status).toBe(200);
    expect(await revokedAt(alice)).toBeNull();
    expect((await listSessions(mixed)).status).toBe(401);

    expect((await logout(alice)).status).toBe(200);
    expect((await listSessions(alice)).status).toBe(401);
    expect((await listSessions(aliceOther)).status).toBe(200);
  });

  it('rejects a cross-site logout without revoking the session', async () => {
    const token = await issue('revocation-alice');
    const response = await logout(token, 'https://attacker.example');
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await revokedAt(token)).toBeNull();
    expect((await listSessions(token)).status).toBe(200);
  });

  it('clears the cookie for a logout without a valid session', async () => {
    for (const token of [null, 'garbage', sign({ sub: 'revocation-alice' })]) {
      const response = await logout(token);
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    }
  });
});

describe('server-side session validity', () => {
  it('rejects a validly signed token whose session identifier was never issued', async () => {
    const token = await issue('revocation-alice');
    const unknown = sign({ ...claimsOf(token), sid: 'never-issued-session' });
    expect((await listSessions(unknown)).status).toBe(401);
    expect((await listSessions(token)).status).toBe(200);
  });

  it('rejects a pre-revocation token without a session identifier', async () => {
    const legacy = sign({
      sub: 'revocation-alice',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect((await listSessions(legacy)).status).toBe(401);
  });

  it('still enforces expiry server-side when the signed exp is in the future', async () => {
    const token = await issue('revocation-alice');
    await pool.query(
      `UPDATE staff_sessions SET issued_at = now() - interval '2 minutes',
         expires_at = now() - interval '1 second'`,
    );
    expect((await listSessions(token)).status).toBe(401);
  });

  it('drops the sessions of a deleted user', async () => {
    const token = await issue('revocation-bob');
    await pool.query('DELETE FROM clinic_memberships WHERE user_id = $1', [
      ids.bob,
    ]);
    await pool.query('DELETE FROM users WHERE id = $1', [ids.bob]);
    expect(await revokedAt(token)).toBeUndefined();
    expect((await listSessions(token)).status).toBe(401);
  });
});
