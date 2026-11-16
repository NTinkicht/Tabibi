import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  registerPatientAccount,
  verifyPatientPassword,
} from '@/modules/identity/patient-credentials';
import {
  issuePatientPasswordReset,
  redeemPatientPasswordReset,
} from '@/modules/identity/patient-recovery';
import { createPatientSessionToken } from '@/platform/http/patient-auth';
import { PasswordPolicyError } from '@/modules/identity/staff-credentials';

// TAB-P1-01 slice 5: patient password recovery token service.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const EMAIL = 'leila.patient@example.test';
const OTHER = 'karim.patient@example.test';
const OLD = 'correct horse battery';
const NEW = 'a brand new staple pass';

const count = async (sql: string) => Number((await pool.query(sql)).rows[0].n);
const userId = async (email: string) =>
  (
    await pool.query('SELECT id FROM users WHERE auth_subject = $1', [
      `patient:${email}`,
    ])
  ).rows[0].id as string;
const addSession = async (id: string) =>
  pool.query(
    `INSERT INTO patient_sessions (verifier, user_id, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [randomBytes(32), id],
  );
const liveSessions = (id: string) =>
  count(
    `SELECT count(*) AS n FROM patient_sessions WHERE user_id = '${id}' AND revoked_at IS NULL`,
  );
const issue = async (email = EMAIL, ttl?: number) => {
  const issued = await issuePatientPasswordReset(pool, email, ttl);
  expect(issued).not.toBeNull();
  return (issued as { token: string }).token;
};

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'patient-recovery-secret-at-least-32-characters';
  await migrate();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE patient_credentials, users CASCADE`);
  for (const [email, name] of [
    [EMAIL, 'Leila'],
    [OTHER, 'Karim'],
  ] as const)
    await registerPatientAccount(pool, {
      email,
      displayName: name,
      password: OLD,
    });
});
afterAll(async () => {
  await pool.end();
});

describe('issuePatientPasswordReset', () => {
  it('stores only the verifier of the token, with a bounded expiry', async () => {
    const issued = await issuePatientPasswordReset(
      pool,
      ` ${EMAIL.toUpperCase()} `,
    );
    expect(issued).not.toBeNull();
    const token = (issued as { token: string }).token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const rows = (
      await pool.query(
        `SELECT verifier, expires_at - created_at AS ttl FROM patient_password_reset_tokens`,
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].verifier.length).toBe(32);
    expect(rows[0].verifier.toString('utf8')).not.toContain(token);
    expect(rows[0].verifier.toString('base64url')).not.toBe(token);
    expect(rows[0].ttl.minutes).toBe(30);
  });

  it('returns null and stores nothing for unknown, malformed and non-patient emails', async () => {
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES (gen_random_uuid(), 'staff-only@example.test', 'S')`,
    );
    for (const email of [
      'nobody@example.test',
      'not-an-email',
      'staff-only@example.test',
    ])
      expect(await issuePatientPasswordReset(pool, email)).toBeNull();
    expect(
      await count('SELECT count(*) AS n FROM patient_password_reset_tokens'),
    ).toBe(0);
    // Positive control: a registered patient does get a token.
    expect(await issuePatientPasswordReset(pool, EMAIL)).not.toBeNull();
  });

  it('supersedes the earlier unused token of the same account only', async () => {
    const first = await issue();
    const otherToken = await issue(OTHER);
    const second = await issue();
    expect(await redeemPatientPasswordReset(pool, first, NEW)).toEqual({
      ok: false,
    });
    expect((await redeemPatientPasswordReset(pool, otherToken, NEW)).ok).toBe(
      true,
    );
    expect((await redeemPatientPasswordReset(pool, second, NEW)).ok).toBe(true);
  });
});

describe('redeemPatientPasswordReset', () => {
  it('replaces the password, clears the lockout and revokes every session', async () => {
    const id = await userId(EMAIL);
    const otherId = await userId(OTHER);
    await addSession(id);
    await addSession(id);
    await addSession(otherId);
    await pool.query(
      `UPDATE patient_credentials SET failed_attempts = 5, locked_until = now() + interval '1 hour' WHERE user_id = $1`,
      [id],
    );
    expect((await verifyPatientPassword(pool, EMAIL, OLD)).ok).toBe(false);
    const token = await issue();
    expect(await redeemPatientPasswordReset(pool, token, NEW)).toEqual({
      ok: true,
      userId: id,
    });
    expect((await verifyPatientPassword(pool, EMAIL, NEW)).ok).toBe(true);
    expect((await verifyPatientPassword(pool, EMAIL, OLD)).ok).toBe(false);
    expect(await liveSessions(id)).toBe(0);
    expect(await liveSessions(otherId)).toBe(1);
    expect((await verifyPatientPassword(pool, OTHER, OLD)).ok).toBe(true);
  });

  it('refuses a replayed token and leaves the password as set', async () => {
    const token = await issue();
    expect((await redeemPatientPasswordReset(pool, token, NEW)).ok).toBe(true);
    expect(
      await redeemPatientPasswordReset(
        pool,
        token,
        'another strong passphrase',
      ),
    ).toEqual({ ok: false });
    expect((await verifyPatientPassword(pool, EMAIL, NEW)).ok).toBe(true);
  });

  it('refuses expired, unknown and malformed tokens identically', async () => {
    const expired = await issue();
    await pool.query(
      `UPDATE patient_password_reset_tokens
          SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'`,
    );
    const unknown = randomBytes(32).toString('base64url');
    for (const token of [expired, unknown, '', 'short', `${unknown}x`])
      expect(await redeemPatientPasswordReset(pool, token, NEW)).toEqual({
        ok: false,
      });
    expect((await verifyPatientPassword(pool, EMAIL, OLD)).ok).toBe(true);
    // Positive control: a fresh token for the same account works.
    expect(
      (await redeemPatientPasswordReset(pool, await issue(), NEW)).ok,
    ).toBe(true);
  });

  it('keeps the token usable when the new password fails the policy', async () => {
    const token = await issue();
    await expect(
      redeemPatientPasswordReset(pool, token, 'short'),
    ).rejects.toBeInstanceOf(PasswordPolicyError);
    expect((await verifyPatientPassword(pool, EMAIL, OLD)).ok).toBe(true);
    expect((await redeemPatientPasswordReset(pool, token, NEW)).ok).toBe(true);
  });

  it('lets exactly one of several concurrent redemptions succeed', async () => {
    const token = await issue();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        redeemPatientPasswordReset(pool, token, `concurrent strong pass ${i}`),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('concurrency barriers', () => {
  it('revokes a session whose sign-in committed while the reset waited on the credential lock', async () => {
    const id = await userId(EMAIL);
    const token = await issue();
    const signIn = await pool.connect();
    try {
      await signIn.query('BEGIN');
      // In-flight sign-in: holds FOR SHARE on the credential, session uncommitted.
      await createPatientSessionToken(
        id,
        new Date(Date.now() + 3_600_000),
        signIn,
      );
      let settled = false;
      const redeem = redeemPatientPasswordReset(pool, token, NEW).then((r) => {
        settled = true;
        return r;
      });
      await sleep(400);
      expect(settled).toBe(false);
      await signIn.query('COMMIT');
      expect((await redeem).ok).toBe(true);
    } finally {
      signIn.release();
    }
    expect(await liveSessions(id)).toBe(0);
  });

  it('serializes overlapping issuances so only the newest token is redeemable', async () => {
    const first = await pool.connect();
    let firstToken: string;
    let secondToken: string;
    try {
      await first.query('BEGIN');
      const a = await issuePatientPasswordReset(first, EMAIL);
      firstToken = (a as { token: string }).token;
      let settled = false;
      const secondIssue = issuePatientPasswordReset(pool, EMAIL).then((r) => {
        settled = true;
        return r;
      });
      await sleep(400);
      expect(settled).toBe(false);
      await first.query('COMMIT');
      secondToken = ((await secondIssue) as { token: string }).token;
    } finally {
      first.release();
    }
    expect(await redeemPatientPasswordReset(pool, firstToken, NEW)).toEqual({
      ok: false,
    });
    expect((await redeemPatientPasswordReset(pool, secondToken, NEW)).ok).toBe(
      true,
    );
  });
});
