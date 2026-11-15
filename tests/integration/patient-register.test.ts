import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { POST as registerPost } from '@/app/api/patient/register/route';
import { POST as signInPost } from '@/app/api/patient/session/route';
import { closePool } from '@/platform/database/pool';

// TAB-P1-01 slice 3: patient registration route.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const SECRET = 'patient-register-secret-at-least-32-characters';
const EMAIL = 'nadia.patient@example.test';
const GOOD = 'correct horse battery';

function post(
  route: typeof registerPost,
  url: string,
  body: unknown,
  origin: string | null = 'http://localhost',
) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (origin !== null) headers.set('origin', origin);
  return route(
    new Request(url, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}
const register = (body: unknown, origin: string | null = 'http://localhost') =>
  post(registerPost, 'http://localhost/api/patient/register', body, origin);
const signIn = (email: string, password: string) =>
  post(signInPost, 'http://localhost/api/patient/session', {
    email,
    password,
  });
const valid = (over: Record<string, unknown> = {}) => ({
  email: EMAIL,
  displayName: 'Nadia',
  password: GOOD,
  ...over,
});
const count = async () =>
  Number(
    (await pool.query('SELECT count(*) FROM patient_credentials')).rows[0]
      .count,
  );

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET = SECRET;
  await migrate();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE patient_credentials, users, staff_sign_in_rate_limit_buckets CASCADE`,
  );
});
afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('POST /api/patient/register', () => {
  it('creates the account without a session and the patient can then sign in', async () => {
    const res = await register(valid());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await count()).toBe(1);
    const stored = await pool.query(
      'SELECT auth_subject, display_name FROM users',
    );
    expect(stored.rows).toEqual([
      { auth_subject: `patient:${EMAIL}`, display_name: 'Nadia' },
    ]);
    expect((await signIn(EMAIL, GOOD)).status).toBe(200);
  });

  it('answers an already-registered email identically and never changes its password', async () => {
    const first = await register(valid());
    const firstBody = await first.text();
    const again = await register(
      valid({ displayName: 'Intruder', password: 'attacker chosen secret' }),
    );
    expect(again.status).toBe(first.status);
    expect(await again.text()).toBe(firstBody);
    expect(again.headers.get('set-cookie')).toBeNull();
    expect(await count()).toBe(1);
    // Positive control: the original credentials still work, the attacker's do not.
    expect((await signIn(EMAIL, GOOD)).status).toBe(200);
    expect((await signIn(EMAIL, 'attacker chosen secret')).status).toBe(401);
    const name = await pool.query('SELECT display_name FROM users');
    expect(name.rows).toEqual([{ display_name: 'Nadia' }]);
  });

  it('normalizes the email so a case variant is the same account', async () => {
    await register(valid());
    const variant = await register(
      valid({ email: ' NADIA.Patient@Example.TEST ' }),
    );
    expect(variant.status).toBe(202);
    expect(await count()).toBe(1);
  });

  it('refuses missing or foreign origin before touching the database', async () => {
    expect((await register(valid(), null)).status).toBe(403);
    expect((await register(valid(), 'http://evil.test')).status).toBe(403);
    expect(await count()).toBe(0);
  });

  it('answers invalid input with one generic 400 and never echoes the password', async () => {
    const cases: unknown[] = [
      valid({ role: 'admin' }),
      valid({ email: 'not-an-email' }),
      valid({ email: 'a:b@example.test' }),
      valid({ password: 'short' }),
      valid({ password: EMAIL }),
      valid({ displayName: '   ' }),
      valid({ displayName: 'bad\u0000name' }),
      '{not json',
      { email: EMAIL },
    ];
    const seen = new Set<string>();
    for (const body of cases) {
      const res = await register(body);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain(GOOD);
      expect(text).not.toContain('short');
      seen.add((JSON.parse(text) as { error: string }).error);
    }
    expect(seen).toEqual(new Set(['invalid_request']));
    const huge = await register(valid({ displayName: 'x'.repeat(6000) }));
    expect(huge.status).toBe(400);
    expect(await count()).toBe(0);
  });

  it('rate limits per email with 429 and retry-after, and still creates nothing new', async () => {
    for (let i = 0; i < 5; i++)
      expect((await register(valid())).status).toBe(202);
    const limited = await register(valid());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('900');
    // Positive control: a different email is not limited.
    expect(
      (await register(valid({ email: 'other.patient@example.test' }))).status,
    ).toBe(202);
    expect(await count()).toBe(2);
  });
});
