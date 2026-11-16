import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { POST as redeemPost } from '@/app/api/patient/recovery/redeem/route';
import {
  GET as meGet,
  POST as signInPost,
} from '@/app/api/patient/session/route';
import { registerPatientAccount } from '@/modules/identity/patient-credentials';
import { issuePatientPasswordReset } from '@/modules/identity/patient-recovery';
import { closePool, getPool } from '@/platform/database/pool';

// TAB-P1-01 slice 6: HTTP redemption of a patient password-reset token.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const EMAIL = 'leila.patient@example.test';
const OTHER = 'karim.patient@example.test';
const OLD = 'correct horse battery';
const NEW = 'a brand new staple pass';

const tokenOf = (res: Response) =>
  /tabibi_patient_session=([^;]+)/.exec(
    res.headers.get('set-cookie') ?? '',
  )?.[1] as string;
const signIn = (email: string, password: string) =>
  signInPost(
    new Request('http://localhost/api/patient/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ email, password }),
    }),
  );
const login = async (email = EMAIL) =>
  `tabibi_patient_session=${tokenOf(await signIn(email, OLD))}`;
const me = (cookie: string) =>
  meGet(
    new Request('http://localhost/api/patient/session', {
      headers: { cookie },
    }),
  );
function redeem(
  body: unknown,
  origin: string | null = 'http://localhost',
  extra: Record<string, string> = {},
) {
  const headers = new Headers({ 'content-type': 'application/json', ...extra });
  if (origin !== null) headers.set('origin', origin);
  return redeemPost(
    new Request('http://localhost/api/patient/recovery/redeem', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}
const issue = async (email = EMAIL) =>
  ((await issuePatientPasswordReset(pool, email)) as { token: string }).token;
const hashes = async () =>
  (
    await pool.query(
      'SELECT password_hash FROM patient_credentials ORDER BY created_at',
    )
  ).rows.map((r) => (r.password_hash as Buffer).toString('hex'));
const usedCount = async () =>
  Number(
    (
      await pool.query(
        'SELECT count(*) AS n FROM patient_password_reset_tokens WHERE used_at IS NOT NULL',
      )
    ).rows[0].n,
  );

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'patient-recovery-route-secret-at-least-32-chars';
  await migrate();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE patient_credentials, users, staff_sign_in_rate_limit_buckets CASCADE`,
  );
  for (const [email, name] of [
    [EMAIL, 'Leila'],
    [OTHER, 'Karim'],
  ] as const)
    await registerPatientAccount(getPool(), {
      email,
      displayName: name,
      password: OLD,
    });
});
afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('POST /api/patient/recovery/redeem', () => {
  it('replaces the password, revokes every session, issues no cookie, spares other accounts', async () => {
    const a = await login();
    const b = await login();
    const other = await login(OTHER);
    const otherBefore = (await hashes())[1];
    const res = await redeem({ token: await issue(), newPassword: NEW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'changed' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await me(a)).status).toBe(401);
    expect((await me(b)).status).toBe(401);
    expect((await me(other)).status).toBe(200);
    expect((await signIn(EMAIL, NEW)).status).toBe(200);
    expect((await signIn(EMAIL, OLD)).status).toBe(401);
    expect((await hashes())[1]).toBe(otherBefore);
  });

  it('is single use: replaying a redeemed token is the generic 400', async () => {
    const token = await issue();
    expect((await redeem({ token, newPassword: NEW })).status).toBe(200);
    const before = await hashes();
    const res = await redeem({ token, newPassword: 'another fresh staple' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
    expect(await hashes()).toEqual(before);
  });

  it('answers malformed, unknown, superseded and expired tokens identically', async () => {
    const stale = await issue();
    const fresh = await issue();
    const expired = (await issuePatientPasswordReset(pool, OTHER, 1)) as {
      token: string;
    };
    await new Promise((r) => setTimeout(r, 1200));
    const before = await hashes();
    const bodies: unknown[] = [];
    for (const token of ['short', 'A'.repeat(43), stale, expired.token]) {
      const res = await redeem({ token, newPassword: NEW });
      expect(res.status).toBe(400);
      bodies.push(await res.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual({ error: 'invalid_token' });
    expect(await hashes()).toEqual(before);
    expect((await redeem({ token: fresh, newPassword: NEW })).status).toBe(200);
  });

  it('reports a policy failure without consuming the token', async () => {
    const token = await issue();
    const before = await hashes();
    const res = await redeem({ token, newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'password_policy',
      code: 'too_short',
    });
    expect(await hashes()).toEqual(before);
    expect(await usedCount()).toBe(0);
    expect((await redeem({ token, newPassword: NEW })).status).toBe(200);
  });

  it('refuses a cross-origin or originless request before touching the token', async () => {
    const token = await issue();
    const before = await hashes();
    for (const origin of ['http://evil.example', null]) {
      const res = await redeem({ token, newPassword: NEW }, origin);
      expect(res.status).toBe(403);
    }
    expect(await hashes()).toEqual(before);
    expect(await usedCount()).toBe(0);
  });

  it('refuses unknown fields, non-JSON and oversized bodies without consuming the token', async () => {
    const token = await issue();
    const before = await hashes();
    for (const body of [
      { token, newPassword: NEW, extra: 1 },
      { token },
      '{not json',
      JSON.stringify({ token, newPassword: 'x'.repeat(5000) }),
    ]) {
      expect((await redeem(body)).status).toBe(400);
    }
    expect(await hashes()).toEqual(before);
    expect(await usedCount()).toBe(0);
  });

  it('rate limits repeated guesses of one token with 429 and Retry-After', async () => {
    const token = 'B'.repeat(43);
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 6; i += 1) {
      last = await redeem({ token, newPassword: NEW });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    expect(last?.headers.get('retry-after')).not.toBeNull();
  });

  it('writes no per-token bucket row once the ingress budget is exhausted', async () => {
    const buckets = async () =>
      Number(
        (
          await pool.query(
            'SELECT count(*) AS n FROM staff_sign_in_rate_limit_buckets',
          )
        ).rows[0].n,
      );
    let first429 = -1;
    for (let i = 0; i < 70 && first429 < 0; i += 1) {
      const token = i.toString(36).padStart(43, 'C');
      if ((await redeem({ token, newPassword: NEW })).status === 429)
        first429 = i;
    }
    expect(first429).toBeGreaterThan(0);
    const before = await buckets();
    const res = await redeem({ token: 'Z'.repeat(43), newPassword: NEW });
    expect(res.status).toBe(429);
    expect(await buckets()).toBe(before);
  });
});
