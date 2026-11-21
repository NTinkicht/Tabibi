import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { POST as passwordPost } from '@/app/api/patient/password/route';
import { POST as logoutPost } from '@/app/api/patient/session/logout/route';
import { POST as signInPost } from '@/app/api/patient/session/route';
import { PatientAccountOperatorError } from '@/modules/identity/patient-account-audit';
import {
  registerPatientAccount,
  verifyPatientPassword,
} from '@/modules/identity/patient-credentials';
import {
  issuePatientPasswordReset,
  redeemPatientPasswordReset,
} from '@/modules/identity/patient-recovery';
import { closePool } from '@/platform/database/pool';

// #971: every patient account credential event writes exactly one audit row in
// the same statement or transaction as the change, and none hold secrets.
// #972: the reset CLI reads the e-mail from stdin and prints a full URL.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const EMAIL = 'leila.patient@example.test';
const OLD = 'correct horse battery';
const NEW = 'a brand new staple pass';
const ORIGIN = 'https://tabibi.example';

type Row = {
  user_id: string;
  actor_kind: string;
  actor_label: string | null;
  action: string;
  metadata: Record<string, unknown>;
};
const rows = async (action?: string): Promise<Row[]> =>
  (
    await pool.query<Row>(
      `SELECT user_id, actor_kind, actor_label, action, metadata
         FROM patient_account_audit_events
        WHERE $1::text IS NULL OR action = $1 ORDER BY id`,
      [action ?? null],
    )
  ).rows;

const cookieOf = (res: Response) =>
  `tabibi_patient_session=${
    /tabibi_patient_session=([^;]+)/.exec(
      res.headers.get('set-cookie') ?? '',
    )?.[1] as string
  }`;
const post = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  cookie?: string,
) =>
  handler(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
const signIn = async (password = OLD) =>
  post(signInPost, '/api/patient/session', { email: EMAIL, password });

let userId = '';

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'patient-audit-secret-at-least-32-characters';
  await migrate();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE patient_credentials, users, staff_sign_in_rate_limit_buckets CASCADE`,
  );
  const created = await registerPatientAccount(pool, {
    email: EMAIL,
    displayName: 'Leila',
    password: OLD,
  });
  userId = (created as { userId: string }).userId;
});
afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('patient account audit (#971)', () => {
  it('records registration once, and a refused duplicate writes nothing', async () => {
    expect(await rows()).toEqual([
      {
        user_id: userId,
        actor_kind: 'patient',
        actor_label: null,
        action: 'account_registered',
        metadata: {},
      },
    ]);
    const again = await registerPatientAccount(pool, {
      email: EMAIL,
      displayName: 'Leila',
      password: OLD,
    });
    expect(again.ok).toBe(false);
    expect(await rows()).toHaveLength(1);
  });

  it('a rolled-back registration leaves no audit row', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await registerPatientAccount(client, {
        email: 'karim.patient@example.test',
        displayName: 'Karim',
        password: OLD,
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await rows()).toHaveLength(1);
  });

  it('records sign-in and sign-out, and a failed sign-in or repeat logout writes nothing', async () => {
    expect((await signIn('wrong password here')).status).toBe(401);
    expect(await rows('signed_in')).toHaveLength(0);
    const cookie = cookieOf(await signIn());
    expect(await rows('signed_in')).toHaveLength(1);
    await post(logoutPost, '/api/patient/session/logout', {}, cookie);
    await post(logoutPost, '/api/patient/session/logout', {}, cookie);
    const out = await rows('signed_out');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ user_id: userId, actor_kind: 'patient' });
  });

  it('records the lockout transition once, not each failure while locked', async () => {
    const options = { maxFailedAttempts: 3, lockoutSeconds: 60 };
    for (let i = 0; i < 6; i += 1)
      await verifyPatientPassword(pool, EMAIL, 'wrong password here', options);
    const locked = await rows('account_locked');
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({ actor_kind: 'system', user_id: userId });
    expect(locked[0]?.metadata).toMatchObject({ failedAttempts: 3 });
    expect(typeof locked[0]?.metadata.lockedUntil).toBe('string');
  });

  it('records a password change and the revocation of other sessions with its count', async () => {
    const mine = cookieOf(await signIn());
    await signIn();
    await signIn();
    const wrong = await post(
      passwordPost,
      '/api/patient/password',
      { currentPassword: 'not the password', newPassword: NEW },
      mine,
    );
    expect(wrong.status).toBe(403);
    expect(await rows('password_changed')).toHaveLength(0);
    const res = await post(
      passwordPost,
      '/api/patient/password',
      { currentPassword: OLD, newPassword: NEW },
      mine,
    );
    expect(res.status).toBe(200);
    expect(await rows('password_changed')).toHaveLength(1);
    const revoked = await rows('sessions_revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.metadata).toEqual({ count: 2 });
  });

  it('records reset issuance with the operator and redemption with the sessions revoked', async () => {
    await signIn();
    await signIn();
    const first = await issuePatientPasswordReset(pool, EMAIL, {
      label: 'Samira (support)',
      hostUser: 'ops',
    });
    const issued = await issuePatientPasswordReset(pool, EMAIL, {
      label: 'Samira (support)',
    });
    expect(first && issued).toBeTruthy();
    const issues = await rows('password_reset_issued');
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      actor_kind: 'operator',
      actor_label: 'Samira (support)',
      metadata: { hostUser: 'ops', supersededTokens: 0 },
    });
    expect(issues[1]?.metadata).toMatchObject({ supersededTokens: 1 });
    expect(issues[1]?.metadata).not.toHaveProperty('hostUser');
    expect(
      await redeemPatientPasswordReset(
        pool,
        (issued as { token: string }).token,
        NEW,
      ),
    ).toMatchObject({ ok: true });
    const redeemed = await rows('password_reset_redeemed');
    expect(redeemed).toHaveLength(1);
    expect(redeemed[0]).toMatchObject({
      actor_kind: 'patient',
      metadata: { sessionsRevoked: 2 },
    });
    // A spent token redeems nothing and audits nothing.
    expect(
      await redeemPatientPasswordReset(
        pool,
        (issued as { token: string }).token,
        NEW,
      ),
    ).toEqual({ ok: false });
    expect(await rows('password_reset_redeemed')).toHaveLength(1);
  });

  it('refuses a reset without a valid operator before anything changes', async () => {
    for (const label of ['', '   ', 'a\u0000b', 'x'.repeat(121)])
      await expect(
        issuePatientPasswordReset(pool, EMAIL, { label }),
      ).rejects.toBeInstanceOf(PatientAccountOperatorError);
    expect(await rows('password_reset_issued')).toHaveLength(0);
    expect(
      (await pool.query('SELECT 1 FROM patient_password_reset_tokens'))
        .rowCount,
    ).toBe(0);
    // Unknown account: no token, no audit row.
    expect(
      await issuePatientPasswordReset(pool, 'nobody@example.test', {
        label: 'Samira',
      }),
    ).toBeNull();
    expect(await rows('password_reset_issued')).toHaveLength(0);
  });

  it('a reset issued inside a rolled-back transaction leaves no audit row', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(
        await issuePatientPasswordReset(
          client as unknown as Pool & { release: () => void },
          EMAIL,
          { label: 'Samira' },
        ),
      ).not.toBeNull();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await rows('password_reset_issued')).toHaveLength(0);
  });

  it('never stores an e-mail, password, token, verifier or hash in an audit row', async () => {
    const cookie = cookieOf(await signIn());
    await signIn();
    await post(
      passwordPost,
      '/api/patient/password',
      { currentPassword: OLD, newPassword: NEW },
      cookie,
    );
    const issued = (await issuePatientPasswordReset(pool, EMAIL, {
      label: 'Samira',
    })) as { token: string };
    await redeemPatientPasswordReset(pool, issued.token, OLD);
    for (let i = 0; i < 12; i += 1)
      await verifyPatientPassword(pool, EMAIL, 'wrong password here');
    await post(logoutPost, '/api/patient/session/logout', {}, cookie);
    const secrets = (
      await pool.query<{ password_hash: Buffer; salt: Buffer }>(
        'SELECT password_hash, salt FROM patient_credentials',
      )
    ).rows.flatMap((r) => [r.password_hash, r.salt]);
    const verifiers = [
      ...(
        await pool.query<{ verifier: Buffer }>(
          'SELECT verifier FROM patient_sessions',
        )
      ).rows,
      ...(
        await pool.query<{ verifier: Buffer }>(
          'SELECT verifier FROM patient_password_reset_tokens',
        )
      ).rows,
    ].map((r) => r.verifier);
    const all = await rows();
    expect(new Set(all.map((r) => r.action))).toEqual(
      new Set([
        'account_registered',
        'signed_in',
        'sessions_revoked',
        'password_changed',
        'password_reset_issued',
        'password_reset_redeemed',
        'account_locked',
      ]),
    );
    const text = JSON.stringify(all).toLowerCase();
    const needles = [
      EMAIL,
      'leila',
      OLD,
      NEW,
      issued.token,
      cookie.split('=')[1] as string,
      ...[...secrets, ...verifiers].flatMap((b) => [
        b.toString('hex'),
        b.toString('base64'),
        b.toString('base64url'),
      ]),
    ];
    for (const needle of needles)
      expect(text).not.toContain(needle.toLowerCase());
  });
});

describe('issue-patient-reset CLI (#971, #972)', () => {
  const run = (
    args: string[],
    input: string,
    env: Record<string, string> = {},
  ) =>
    spawnSync('npx', ['tsx', 'scripts/db/issue-patient-reset.ts', ...args], {
      input,
      encoding: 'utf8',
      env: { ...process.env, PUBLIC_ORIGIN: ORIGIN, ...env },
    });

  it('reads the e-mail from stdin, prints a full link and records the operator', () => {
    const args = ['--operator', 'Samira (support)'];
    const result = run(args, `${EMAIL}\n`);
    expect(result.status).toBe(0);
    expect(args.join(' ')).not.toContain(EMAIL);
    expect(result.stdout).toMatch(
      /^Reset link \(single use\): https:\/\/tabibi\.example\/account\/reset#[A-Za-z0-9_-]{43}$/mu,
    );
    expect(result.stdout).toContain('audit log');
    expect(result.stdout + result.stderr).not.toContain(EMAIL);
  }, 60_000);

  it('the audited issuance names the operator and the host user', async () => {
    run(['--operator', 'Samira'], `${EMAIL}\n`);
    const issued = await rows('password_reset_issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      actor_kind: 'operator',
      actor_label: 'Samira',
      metadata: { hostUser: userInfo().username },
    });
  }, 60_000);

  it('refuses without an operator, with --email, or without a usable public origin', async () => {
    const cases: [string[], Record<string, string>, RegExp][] = [
      [[], {}, /--operator/],
      [['--operator', 'S', '--email', EMAIL], {}, /stdin/],
      [['--operator', 'S'], { PUBLIC_ORIGIN: '' }, /PUBLIC_ORIGIN is not set/],
      [
        ['--operator', 'S'],
        { PUBLIC_ORIGIN: 'http://tabibi.example' },
        /https origin/,
      ],
      [
        ['--operator', 'S'],
        { PUBLIC_ORIGIN: `${ORIGIN}/account` },
        /https origin/,
      ],
    ];
    for (const [args, env, message] of cases) {
      const result = run(args, `${EMAIL}\n`, env);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(message);
      expect(result.stdout).not.toContain('/account/reset#');
    }
    expect(await rows('password_reset_issued')).toHaveLength(0);
    expect(
      (await pool.query('SELECT 1 FROM patient_password_reset_tokens'))
        .rowCount,
    ).toBe(0);
  }, 120_000);
});
