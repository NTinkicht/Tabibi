import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Queryable } from './index';

// TAB-P0-01 (#723). Local staff credentials using Node's built-in scrypt.
// Nothing here logs, throws or returns a password, hash, salt or parameters.

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
export const DEFAULT_LOCKOUT_SECONDS = 900;

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const DEFAULT_PARAMS = { n: 32768, r: 8, p: 1 } as const;

export type PasswordPolicyCode = 'too_short' | 'too_long' | 'matches_identity';

export class PasswordPolicyError extends Error {
  readonly code: PasswordPolicyCode;
  constructor(code: PasswordPolicyCode) {
    super(`Password does not satisfy the staff password policy (${code})`);
    this.name = 'PasswordPolicyError';
    this.code = code;
  }
}

export class StaffCredentialUserNotFoundError extends Error {
  constructor() {
    super('Staff user does not exist');
    this.name = 'StaffCredentialUserNotFoundError';
  }
}

export interface LockoutOptions {
  maxFailedAttempts?: number;
  lockoutSeconds?: number;
}

export type VerifyResult = { ok: true; userId: string } | { ok: false };

interface ScryptParams {
  n: number;
  r: number;
  p: number;
}

function derive(
  password: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      {
        N: params.n,
        r: params.r,
        p: params.p,
        maxmem: 256 * params.n * params.r + 1024 * 1024,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export function validatePasswordPolicy(
  password: string,
  authSubject: string,
): void {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH) throw new PasswordPolicyError('too_short');
  if (length > PASSWORD_MAX_LENGTH) throw new PasswordPolicyError('too_long');
  const candidate = password.normalize('NFKC').trim().toLowerCase();
  const subject = authSubject.normalize('NFKC').trim().toLowerCase();
  const local = subject.includes('@') ? subject.split('@')[0]! : subject;
  if (candidate === subject || (local !== '' && candidate === local)) {
    throw new PasswordPolicyError('matches_identity');
  }
}

function lockoutSettings(options?: LockoutOptions): {
  max: number;
  seconds: number;
} {
  const max = options?.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS;
  const seconds = options?.lockoutSeconds ?? DEFAULT_LOCKOUT_SECONDS;
  if (
    !Number.isInteger(max) ||
    max < 1 ||
    !Number.isInteger(seconds) ||
    seconds < 1
  ) {
    throw new RangeError('Invalid staff lockout configuration');
  }
  return { max, seconds };
}

let dummyCredential: Promise<{ salt: Buffer; hash: Buffer }> | undefined;
function dummy(): Promise<{ salt: Buffer; hash: Buffer }> {
  dummyCredential ??= (async () => {
    const salt = randomBytes(SALT_LENGTH);
    return {
      salt,
      hash: await derive(randomBytes(24).toString('hex'), salt, DEFAULT_PARAMS),
    };
  })();
  return dummyCredential;
}

export async function setStaffPassword(
  db: Queryable,
  userId: string,
  password: string,
): Promise<void> {
  const user = await db.query<{ auth_subject: string }>(
    'SELECT auth_subject FROM users WHERE id = $1',
    [userId],
  );
  const subject = user.rows[0]?.auth_subject;
  if (subject === undefined) throw new StaffCredentialUserNotFoundError();
  validatePasswordPolicy(password, subject);
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, DEFAULT_PARAMS);
  await db.query(
    `INSERT INTO staff_credentials
       (user_id, password_hash, salt, scrypt_n, scrypt_r, scrypt_p)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       password_hash = EXCLUDED.password_hash, salt = EXCLUDED.salt,
       scrypt_n = EXCLUDED.scrypt_n, scrypt_r = EXCLUDED.scrypt_r,
       scrypt_p = EXCLUDED.scrypt_p, password_changed_at = now(),
       failed_attempts = 0, locked_until = NULL, updated_at = now()`,
    [userId, hash, salt, DEFAULT_PARAMS.n, DEFAULT_PARAMS.r, DEFAULT_PARAMS.p],
  );
}

/**
 * Unknown user, wrong password and locked account all run one scrypt derivation
 * and return the identical `{ ok: false }` result.
 */
export async function verifyStaffPassword(
  db: Queryable,
  authSubject: string,
  password: string,
  options?: LockoutOptions,
): Promise<VerifyResult> {
  const { max, seconds } = lockoutSettings(options);
  const attempt = password.length > PASSWORD_MAX_LENGTH * 4 ? '' : password;
  const found = await db.query<{
    user_id: string;
    password_hash: Buffer;
    salt: Buffer;
    scrypt_n: number;
    scrypt_r: number;
    scrypt_p: number;
  }>(
    `SELECT credential.user_id, credential.password_hash, credential.salt,
            credential.scrypt_n, credential.scrypt_r, credential.scrypt_p
       FROM staff_credentials credential
       JOIN users ON users.id = credential.user_id
      WHERE users.auth_subject = $1`,
    [authSubject],
  );
  const row = found.rows[0];
  if (!row) {
    const fake = await dummy();
    const derived = await derive(attempt, fake.salt, DEFAULT_PARAMS);
    timingSafeEqual(derived, fake.hash);
    return { ok: false };
  }
  const derived = await derive(attempt, row.salt, {
    n: row.scrypt_n,
    r: row.scrypt_r,
    p: row.scrypt_p,
  });
  const matches =
    password === attempt && timingSafeEqual(derived, row.password_hash);
  if (matches) {
    const reset = await db.query(
      `UPDATE staff_credentials
          SET failed_attempts = 0, locked_until = NULL, updated_at = now()
        WHERE user_id = $1 AND password_hash = $2
          AND (locked_until IS NULL OR locked_until <= now())`,
      [row.user_id, row.password_hash],
    );
    if (reset.rowCount === 1) return { ok: true, userId: row.user_id };
    return { ok: false };
  }
  await db.query(
    `UPDATE staff_credentials SET
       failed_attempts = CASE
         WHEN locked_until > now() THEN failed_attempts
         WHEN locked_until IS NOT NULL THEN 1
         ELSE failed_attempts + 1 END,
       locked_until = CASE
         WHEN locked_until > now() THEN locked_until
         WHEN (CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_attempts + 1 END) >= $2
           THEN now() + make_interval(secs => $3::int)
         ELSE NULL END,
       updated_at = now()
     WHERE user_id = $1 AND password_hash = $4`,
    [row.user_id, max, seconds, row.password_hash],
  );
  return { ok: false };
}
