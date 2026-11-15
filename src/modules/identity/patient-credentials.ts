import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Queryable } from './index';
import {
  DEFAULT_PARAMS,
  PASSWORD_MAX_LENGTH,
  SALT_LENGTH,
  derive,
  dummy,
  lockoutSettings,
  validatePasswordPolicy,
  type LockoutOptions,
  type VerifyResult,
} from './staff-credentials';

// TAB-P1-01 slice 1 (#875). Patient accounts are users rows with the namespaced
// subject `patient:<email>`; their password lives in patient_credentials, never
// in staff_credentials. Nothing here logs, throws or returns a password, hash,
// salt or parameters, and "already registered" is indistinguishable from other
// refusals to the caller.

export const PATIENT_SUBJECT_PREFIX = 'patient:';
const EMAIL_MAX_LENGTH = 254;
const DISPLAY_NAME_MAX_CODE_POINTS = 160;
const EMAIL_SHAPE = /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/u;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

export type PatientRegistrationErrorCode = 'invalid_email' | 'invalid_name';

export class PatientRegistrationInputError extends Error {
  readonly code: PatientRegistrationErrorCode;
  constructor(code: PatientRegistrationErrorCode) {
    super(`Patient registration input is invalid (${code})`);
    this.name = 'PatientRegistrationInputError';
    this.code = code;
  }
}

export type RegisterResult = { ok: true; userId: string } | { ok: false };

export function normalizePatientEmail(email: string): string | null {
  const normalized = email.normalize('NFKC').trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > EMAIL_MAX_LENGTH) {
    return null;
  }
  return EMAIL_SHAPE.test(normalized) ? normalized : null;
}

function normalizeDisplayName(name: string): string {
  const normalized = name.normalize('NFC').trim();
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > DISPLAY_NAME_MAX_CODE_POINTS ||
    CONTROL_OR_FORMAT.test(normalized)
  ) {
    throw new PatientRegistrationInputError('invalid_name');
  }
  return normalized;
}

export async function registerPatientAccount(
  db: Queryable,
  input: { email: string; displayName: string; password: string },
): Promise<RegisterResult> {
  const email = normalizePatientEmail(input.email);
  if (email === null) throw new PatientRegistrationInputError('invalid_email');
  const displayName = normalizeDisplayName(input.displayName);
  validatePasswordPolicy(input.password, email);
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(input.password, salt, DEFAULT_PARAMS);
  // One statement: the user and its credential are created together or not at
  // all, and a concurrent duplicate loses on the unique auth_subject.
  const created = await db.query<{ user_id: string }>(
    `WITH new_user AS (
       INSERT INTO users (id, auth_subject, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (auth_subject) DO NOTHING
       RETURNING id
     )
     INSERT INTO patient_credentials
       (user_id, password_hash, salt, scrypt_n, scrypt_r, scrypt_p)
     SELECT id, $4, $5, $6, $7, $8 FROM new_user
     RETURNING user_id`,
    [
      randomUUID(),
      `${PATIENT_SUBJECT_PREFIX}${email}`,
      displayName,
      hash,
      salt,
      DEFAULT_PARAMS.n,
      DEFAULT_PARAMS.r,
      DEFAULT_PARAMS.p,
    ],
  );
  const row = created.rows[0];
  return row ? { ok: true, userId: row.user_id } : { ok: false };
}

/**
 * Unknown email, wrong password and locked account all run one scrypt
 * derivation and return the identical `{ ok: false }` result.
 */
export async function verifyPatientPassword(
  db: Queryable,
  email: string,
  password: string,
  options?: LockoutOptions,
): Promise<VerifyResult> {
  const { max, seconds } = lockoutSettings(options);
  const normalized = normalizePatientEmail(email);
  const attempt = password.length > PASSWORD_MAX_LENGTH * 4 ? '' : password;
  const found =
    normalized === null
      ? undefined
      : (
          await db.query<{
            user_id: string;
            password_hash: Buffer;
            salt: Buffer;
            scrypt_n: number;
            scrypt_r: number;
            scrypt_p: number;
          }>(
            `SELECT credential.user_id, credential.password_hash, credential.salt,
                    credential.scrypt_n, credential.scrypt_r, credential.scrypt_p
               FROM patient_credentials credential
               JOIN users ON users.id = credential.user_id
              WHERE users.auth_subject = $1`,
            [`${PATIENT_SUBJECT_PREFIX}${normalized}`],
          )
        ).rows[0];
  if (!found) {
    const fake = await dummy();
    const derived = await derive(attempt, fake.salt, DEFAULT_PARAMS);
    timingSafeEqual(derived, fake.hash);
    return { ok: false };
  }
  const derived = await derive(attempt, found.salt, {
    n: found.scrypt_n,
    r: found.scrypt_r,
    p: found.scrypt_p,
  });
  const matches =
    password === attempt && timingSafeEqual(derived, found.password_hash);
  if (matches) {
    const reset = await db.query(
      `UPDATE patient_credentials
          SET failed_attempts = 0, locked_until = NULL, updated_at = now()
        WHERE user_id = $1 AND password_hash = $2
          AND (locked_until IS NULL OR locked_until <= now())`,
      [found.user_id, found.password_hash],
    );
    return reset.rowCount === 1
      ? { ok: true, userId: found.user_id }
      : { ok: false };
  }
  await db.query(
    `UPDATE patient_credentials SET
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
    [found.user_id, max, seconds, found.password_hash],
  );
  return { ok: false };
}

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: 'current_password_invalid' };

/**
 * Replaces the password of a signed-in patient account. The new password must
 * satisfy the shared policy (throws PasswordPolicyError before any state
 * changes). The current password is checked through the lockout-aware
 * verifyPatientPassword, so wrong guesses count toward the account lockout, and
 * the hash is swapped with a compare-and-set on the hash that was verified.
 */
export async function changePatientPassword(
  db: Queryable,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const account = await db.query<{
    auth_subject: string;
    password_hash: Buffer;
  }>(
    `SELECT u.auth_subject, c.password_hash
       FROM users u
       JOIN patient_credentials c ON c.user_id = u.id
      WHERE u.id = $1 AND u.auth_subject LIKE $2`,
    [userId, `${PATIENT_SUBJECT_PREFIX}%`],
  );
  const current = account.rows[0];
  const subject = current?.auth_subject;
  if (!current || !subject)
    return { ok: false, reason: 'current_password_invalid' };
  const email = subject.slice(PATIENT_SUBJECT_PREFIX.length);
  validatePasswordPolicy(newPassword, email);
  const verified = await verifyPatientPassword(db, email, currentPassword);
  if (!verified.ok || verified.userId !== userId)
    return { ok: false, reason: 'current_password_invalid' };
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(newPassword, salt, DEFAULT_PARAMS);
  const updated = await db.query(
    `UPDATE patient_credentials
        SET password_hash = $2, salt = $3, scrypt_n = $4, scrypt_r = $5,
            scrypt_p = $6, password_changed_at = now(), failed_attempts = 0,
            locked_until = NULL, updated_at = now()
      WHERE user_id = $1 AND password_hash = $7`,
    [
      userId,
      hash,
      salt,
      DEFAULT_PARAMS.n,
      DEFAULT_PARAMS.r,
      DEFAULT_PARAMS.p,
      current.password_hash,
    ],
  );
  return updated.rowCount === 1
    ? { ok: true }
    : { ok: false, reason: 'current_password_invalid' };
}
