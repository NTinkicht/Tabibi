import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { GET as sessionsGet } from '@/app/api/clinics/[clinicId]/sessions/route';
import { POST as logoutPost } from '@/app/api/staff/session/logout/route';
import { POST as signInPost } from '@/app/api/staff/session/route';
import { setStaffPassword } from '@/modules/identity/staff-credentials';
import { closePool } from '@/platform/database/pool';
import { getLogger } from '@/platform/observability/logger';

// TAB-P0-01 (#725): POST /api/staff/session.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const SECRET = 'staff-sign-in-secret-at-least-32-characters';
const SUBJECT = 'signin-alice@example.test';
const GOOD = 'correct horse battery';
const COOKIE = 'tabibi_staff_session';
const ids = { clinic: randomUUID(), alice: randomUUID(), bob: randomUUID() };

function signIn(
  body: unknown,
  extra: Record<string, string> = {},
  origin: string | null = 'http://localhost',
) {
  const headers = new Headers({ 'content-type': 'application/json', ...extra });
  if (origin !== null) headers.set('origin', origin);
  return signInPost(
    new Request('http://localhost/api/staff/session', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const good = () => signIn({ subject: SUBJECT, password: GOOD });
const tokenOf = (res: Response) =>
  /tabibi_staff_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];

function listSessions(token: string) {
  return sessionsGet(
    new Request(
      `http://localhost/api/clinics/${ids.clinic}/sessions?date=2026-10-24`,
      { headers: { cookie: `${COOKIE}=${token}` } },
    ),
    { params: Promise.resolve({ clinicId: ids.clinic }) },
  );
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET = SECRET;
  await migrate();
});
beforeEach(async () => {
  delete process.env.STAFF_SESSION_TTL_SECONDS;
  await pool.query(
    `TRUNCATE staff_credentials, clinic_memberships, clinics, users,
       guest_status_rate_limit_buckets, staff_sign_in_rate_limit_buckets CASCADE`,
  );
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,$2,'Alice'),($3,'signin-bob@example.test','Bob')`,
    [ids.alice, SUBJECT, ids.bob],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'signin-clinic','Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.alice],
  );
  await setStaffPassword(pool, ids.alice, GOOD);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('staff sign-in route (#725)', () => {
  it('issues a hardened cookie and returns only memberships', async () => {
    const res = await good();
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=43200');
    const body = await res.json();
    expect(body).toEqual({
      memberships: [{ clinicId: ids.clinic, role: 'receptionist' }],
    });
    const token = tokenOf(res)!;
    expect(JSON.stringify(body)).not.toContain(token);
    expect((await listSessions(token)).status).not.toBe(401);
  });

  it('honours a configured, clamped session lifetime', async () => {
    process.env.STAFF_SESSION_TTL_SECONDS = '3600';
    expect((await good()).headers.get('set-cookie')).toContain('Max-Age=3600');
    process.env.STAFF_SESSION_TTL_SECONDS = '999999999';
    expect((await good()).headers.get('set-cookie')).toContain('Max-Age=86400');
    process.env.STAFF_SESSION_TTL_SECONDS = '1';
    expect((await good()).headers.get('set-cookie')).toContain('Max-Age=300');
  });

  it('returns one uniform 401 for unknown user, wrong password and locked account', async () => {
    const unknown = await signIn({ subject: 'nobody@x.test', password: GOOD });
    const wrong = await signIn({
      subject: SUBJECT,
      password: 'wrong password!',
    });
    for (let i = 0; i < 5; i++)
      await signIn({ subject: SUBJECT, password: 'wrong password!' });
    const locked = await signIn({ subject: SUBJECT, password: GOOD });
    const shapes = await Promise.all(
      [unknown, wrong, locked].map(async (r) => {
        expect(r.headers.get('set-cookie')).toBeNull();
        expect(r.headers.get('retry-after')).toBeNull();
        const b = await r.json();
        return { status: r.status, error: b.error, message: b.message };
      }),
    );
    expect(shapes[0]).toEqual({
      status: 401,
      error: 'authentication_required',
      message: 'Authentication required',
    });
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  it('accepts the password again once the lockout window has expired', async () => {
    for (let i = 0; i < 5; i++)
      await signIn({ subject: SUBJECT, password: 'wrong password!' });
    expect((await good()).status).toBe(401);
    await pool.query(
      `UPDATE staff_credentials SET locked_until = now() - interval '1 second'`,
    );
    expect((await good()).status).toBe(200);
  });

  it('rejects missing and foreign origins before any work', async () => {
    const body = { subject: SUBJECT, password: GOOD };
    expect((await signIn(body, {}, null)).status).toBe(403);
    expect((await signIn(body, {}, 'https://evil.example')).status).toBe(403);
    expect((await pool.query('SELECT 1 FROM staff_sessions')).rowCount).toBe(0);
    expect(
      (await pool.query('SELECT 1 FROM staff_sign_in_rate_limit_buckets'))
        .rowCount,
    ).toBe(0);
  });

  it('rejects oversized, invalid and unexpected bodies with a generic 400', async () => {
    const huge = JSON.stringify({
      subject: SUBJECT,
      password: 'x'.repeat(8000),
    });
    const cases: unknown[] = [
      huge,
      '{"subject":"a","password":"SECRET-PW-FRAGMENT',
      {},
      { subject: SUBJECT },
      { subject: SUBJECT, password: GOOD, role: 'admin' },
      { subject: 7, password: GOOD },
      '',
    ];
    for (const body of cases) {
      const res = await signIn(body);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain('SECRET-PW-FRAGMENT');
      expect(text).not.toContain(GOOD);
    }
    // Oversized by declared length alone is refused without reading the body.
    const declared = await signIn(
      { subject: SUBJECT, password: GOOD },
      { 'content-length': '999999' },
    );
    expect(declared.status).toBe(400);
  });

  it('revokes the session carried by a stale cookie on a new sign-in', async () => {
    const first = tokenOf(await good())!;
    const second = await signInPost(
      new Request('http://localhost/api/staff/session', {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          cookie: `${COOKIE}=${first}`,
        },
        body: JSON.stringify({ subject: SUBJECT, password: GOOD }),
      }),
    );
    expect(second.status).toBe(200);
    expect((await listSessions(first)).status).toBe(401);
    expect((await listSessions(tokenOf(second)!)).status).not.toBe(401);
    const active = await pool.query(
      'SELECT 1 FROM staff_sessions WHERE revoked_at IS NULL',
    );
    expect(active.rowCount).toBe(1);
  });

  it('does not let a duplicated session cookie revoke anything', async () => {
    const first = tokenOf(await good())!;
    const res = await signInPost(
      new Request('http://localhost/api/staff/session', {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          cookie: `${COOKIE}=${first}; ${COOKIE}=${first}`,
        },
        body: JSON.stringify({ subject: SUBJECT, password: GOOD }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await listSessions(first)).status).not.toBe(401);
  });

  it('rejects the token after logout on a protected staff route', async () => {
    const token = tokenOf(await good())!;
    const out = await logoutPost(
      new Request('http://localhost/api/staff/session/logout', {
        method: 'POST',
        headers: { origin: 'http://localhost', cookie: `${COOKIE}=${token}` },
      }),
    );
    expect(out.status).toBe(200);
    expect((await listSessions(token)).status).toBe(401);
  });

  it('issues independent sessions for parallel sign-ins', async () => {
    const results = await Promise.all([good(), good(), good()]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const tokens = results.map((r) => tokenOf(r)!);
    expect(new Set(tokens).size).toBe(3);
    for (const t of tokens)
      expect((await listSessions(t)).status).not.toBe(401);
  });

  it('rate-limits per account with Retry-After, without revealing account state', async () => {
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 12; i++) {
      last = await signIn(
        { subject: 'ghost@x.test', password: GOOD },
        { 'x-forwarded-for': `10.0.0.${i}` },
      );
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(last!.headers.get('retry-after')).toBe('900');
    const buckets = await pool.query<{ bucket_key: string }>(
      'SELECT bucket_key FROM staff_sign_in_rate_limit_buckets',
    );
    expect(JSON.stringify(buckets.rows)).not.toContain('ghost');
  });

  it('rotating x-forwarded-for cannot bypass the ingress limit', async () => {
    await pool.query(
      `INSERT INTO staff_sign_in_rate_limit_buckets
         (bucket_key, window_started_at, request_count)
       VALUES ('staff-signin:ingress', now(), 299)`,
    );
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await signIn(
        { subject: `user${i}@x.test`, password: GOOD },
        {
          'x-forwarded-for': `198.51.100.${i}`,
          'x-real-ip': `10.1.${i}.1`,
        },
      );
      statuses.push(r.status);
    }
    expect(statuses).toEqual([401, 429, 429]);
  });

  it('guest-route bucket cleanup cannot reset a sign-in window', async () => {
    for (let i = 0; i < 10; i++)
      await signIn({ subject: 'ghost@x.test', password: GOOD });
    expect(
      (await signIn({ subject: 'ghost@x.test', password: GOOD })).status,
    ).toBe(429);
    // Age every row past the guest cleanup horizon, then run the guest
    // routes' exact cleanup statement (no namespace filter) against the pool.
    await pool.query(
      `UPDATE staff_sign_in_rate_limit_buckets SET window_started_at = now() - interval '5 minutes'`,
    );
    await pool.query(
      `DELETE FROM guest_status_rate_limit_buckets
        WHERE bucket_key <> 'x' AND window_started_at < now() - interval '60 seconds'`,
    );
    expect(
      (await signIn({ subject: 'ghost@x.test', password: GOOD })).status,
    ).toBe(429);
  });

  it('writes no body, cookie or subject to request logs', async () => {
    const logger = getLogger();
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((l) =>
      vi.spyOn(logger, l),
    );
    await good();
    await signIn({ subject: SUBJECT, password: 'wrong password!' });
    await signIn('{"password":"LOGGED-PW');
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of [GOOD, 'wrong password!', 'LOGGED-PW', SUBJECT])
      expect(logged).not.toContain(secret);
    expect(logged).not.toContain(COOKIE);
  });

  it('stores only a verifier of the new session', async () => {
    const token = tokenOf(await good())!;
    const payload = JSON.parse(
      Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'),
    ) as { sid: string };
    const row = await pool.query<{ verifier: Buffer }>(
      'SELECT verifier FROM staff_sessions',
    );
    expect(row.rows[0]?.verifier).toEqual(
      createHash('sha256').update(payload.sid).digest(),
    );
  });
});
