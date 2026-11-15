import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { POST as passwordPost } from '@/app/api/patient/password/route';
import {
  GET as meGet,
  POST as signInPost,
} from '@/app/api/patient/session/route';
import { registerPatientAccount } from '@/modules/identity/patient-credentials';
import { closePool, getPool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

// TAB-P1-01 slice 4: signed-in patient password change.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const SECRET = 'patient-password-secret-at-least-32-characters';
const EMAIL = 'leila.patient@example.test';
const OTHER = 'karim.patient@example.test';
const OLD = 'correct horse battery';
const NEW = 'a brand new staple pass';
const PCOOKIE = 'tabibi_patient_session';

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
const login = async (email = EMAIL, password = OLD) =>
  `${PCOOKIE}=${tokenOf(await signIn(email, password))}`;
const me = (cookie: string) =>
  meGet(
    new Request('http://localhost/api/patient/session', {
      headers: { cookie },
    }),
  );
function change(
  cookie: string | null,
  body: unknown,
  origin: string | null = 'http://localhost',
) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (origin !== null) headers.set('origin', origin);
  if (cookie) headers.set('cookie', cookie);
  return passwordPost(
    new Request('http://localhost/api/patient/password', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}
const valid = (over: Record<string, unknown> = {}) => ({
  currentPassword: OLD,
  newPassword: NEW,
  ...over,
});
const hashOf = async () =>
  (
    await pool.query(
      'SELECT password_hash FROM patient_credentials ORDER BY created_at',
    )
  ).rows.map((r) => (r.password_hash as Buffer).toString('hex'));

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET = SECRET;
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

describe('POST /api/patient/password', () => {
  it('changes the password, revokes other sessions, keeps the caller and other accounts', async () => {
    const current = await login();
    const second = await login();
    const otherAccount = await login(OTHER);
    const res = await change(current, valid());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'changed' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await me(current)).status).toBe(200);
    expect((await me(second)).status).toBe(401);
    expect((await me(otherAccount)).status).toBe(200);
    expect((await signIn(EMAIL, NEW)).status).toBe(200);
    expect((await signIn(EMAIL, OLD)).status).toBe(401);
    // The other account's password is untouched.
    expect((await signIn(OTHER, OLD)).status).toBe(200);
  });

  it('refuses a wrong current password with one 403 and changes nothing', async () => {
    const cookie = await login();
    const second = await login();
    const before = await hashOf();
    const res = await change(cookie, valid({ currentPassword: 'not the one' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'current_password_invalid' });
    expect(await hashOf()).toEqual(before);
    expect((await me(second)).status).toBe(200);
    const failed = await pool.query(
      `SELECT failed_attempts FROM patient_credentials c JOIN users u ON u.id = c.user_id WHERE u.auth_subject = $1`,
      [`patient:${EMAIL}`],
    );
    // One failed guess was counted toward the lockout.
    expect(failed.rows[0].failed_attempts).toBe(1);
    expect((await signIn(EMAIL, OLD)).status).toBe(200);
  });

  it('locks the account after repeated wrong current passwords', async () => {
    const cookie = await login();
    await pool.query(
      `UPDATE patient_credentials SET failed_attempts = 4
        WHERE user_id = (SELECT id FROM users WHERE auth_subject = $1)`,
      [`patient:${EMAIL}`],
    );
    expect(
      (await change(cookie, valid({ currentPassword: 'nope nope nope' })))
        .status,
    ).toBe(403);
    // Locked now: even the correct current password is refused for that reason.
    const locked = await change(cookie, valid());
    expect(locked.status).toBe(403);
    expect((await signIn(EMAIL, OLD)).status).toBe(401);
  });

  it('rejects a new password that fails policy with its code and changes nothing', async () => {
    const cookie = await login();
    const second = await login();
    const before = await hashOf();
    const short = await change(cookie, valid({ newPassword: 'short' }));
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({
      error: 'password_policy',
      code: 'too_short',
    });
    const identity = await change(cookie, valid({ newPassword: EMAIL }));
    expect(await identity.json()).toEqual({
      error: 'password_policy',
      code: 'matches_identity',
    });
    expect(await hashOf()).toEqual(before);
    expect((await me(second)).status).toBe(200);
  });

  it('requires a patient session and rejects staff tokens', async () => {
    expect((await change(null, valid())).status).toBe(401);
    expect((await change(`${PCOOKIE}=garbage`, valid())).status).toBe(401);
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES(gen_random_uuid(),'someone@example.test','Staff')`,
    );
    const staff = await createStaffSessionToken(
      'someone@example.test',
      new Date(Date.now() + 3600_000),
    );
    expect(
      (await change(`tabibi_staff_session=${staff}`, valid())).status,
    ).toBe(401);
    const cookie = await login();
    // Positive control: the same request with a real session works.
    expect((await change(cookie, valid())).status).toBe(200);
  });

  it('logs out sessions that were revoked by an earlier change', async () => {
    const cookie = await login();
    const stale = await login();
    expect((await change(cookie, valid())).status).toBe(200);
    // The revoked session cannot change the password either.
    expect(
      (
        await change(
          stale,
          valid({
            currentPassword: NEW,
            newPassword: 'yet another pass phrase',
          }),
        )
      ).status,
    ).toBe(401);
    expect((await signIn(EMAIL, NEW)).status).toBe(200);
  });

  it('refuses a foreign or missing origin without changing anything', async () => {
    const cookie = await login();
    const before = await hashOf();
    expect((await change(cookie, valid(), null)).status).toBe(403);
    expect((await change(cookie, valid(), 'http://evil.test')).status).toBe(
      403,
    );
    expect(await hashOf()).toEqual(before);
    expect((await change(cookie, valid())).status).toBe(200);
  });

  it('answers malformed bodies with one generic 400 that never echoes passwords', async () => {
    const cookie = await login();
    const cases: unknown[] = [
      valid({ role: 'admin' }),
      { currentPassword: OLD },
      valid({ newPassword: '' }),
      valid({ newPassword: 'x'.repeat(2000) }),
      '{not json',
    ];
    const seen = new Set<string>();
    for (const body of cases) {
      const res = await change(cookie, body);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain(OLD);
      seen.add((JSON.parse(text) as { error: string }).error);
    }
    expect(seen).toEqual(new Set(['invalid_request']));
    expect((await signIn(EMAIL, OLD)).status).toBe(200);
  });

  it('refuses a body over the 4096 byte cap for that reason alone', async () => {
    const cookie = await login();
    const body = JSON.stringify(valid());
    const over = body + ' '.repeat(4097 - Buffer.byteLength(body));
    const under = body + ' '.repeat(4096 - Buffer.byteLength(body));
    expect((await change(cookie, over)).status).toBe(400);
    expect((await signIn(EMAIL, OLD)).status).toBe(200);
    expect((await change(cookie, under)).status).toBe(200);
  });

  it('rate limits per account at 5 attempts with retry-after', async () => {
    const cookie = await login();
    for (let i = 0; i < 5; i++)
      expect(
        (await change(cookie, valid({ newPassword: 'short' }))).status,
      ).toBe(400);
    const limited = await change(cookie, valid());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('900');
    expect((await signIn(EMAIL, OLD)).status).toBe(200);
    // Positive control: another account's budget is separate.
    const other = await login(OTHER);
    expect((await change(other, valid())).status).toBe(200);
  });
});
