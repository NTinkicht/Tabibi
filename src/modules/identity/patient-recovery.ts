import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from './index';
import {
  normalizePatientEmail,
  PATIENT_SUBJECT_PREFIX,
} from './patient-credentials';
import {
  DEFAULT_PARAMS,
  SALT_LENGTH,
  derive,
  validatePasswordPolicy,
} from './staff-credentials';

// TAB-P1-01 slice 5 (#909). Service layer for patient password recovery. It
// issues and redeems single-use tokens; delivering the token to the patient and
// the HTTP routes are separate slices. Only the SHA-256 verifier of a token is
// stored, and every refusal to redeem is the same `{ ok: false }`.

export const PATIENT_RESET_TOKEN_TTL_SECONDS = 30 * 60;
const TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/u;

const verifierOf = (token: string): Buffer =>
  createHash('sha256').update(token, 'utf8').digest();

export type IssueResetResult = { token: string; expiresAt: Date } | null;

/**
 * Returns a fresh token for an existing patient account, or null when the email
 * is invalid or has no patient account (the caller answers identically either
 * way). Issuing supersedes every earlier unused token of the account.
 */
export async function issuePatientPasswordReset(
  db: Queryable,
  email: string,
  ttlSeconds: number = PATIENT_RESET_TOKEN_TTL_SECONDS,
): Promise<IssueResetResult> {
  const normalized = normalizePatientEmail(email);
  if (normalized === null) return null;
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const issued = await db.query<{ expires_at: Date }>(
    `WITH account AS (
       SELECT c.user_id
         FROM patient_credentials c JOIN users u ON u.id = c.user_id
        WHERE u.auth_subject = $1
     ),
     superseded AS (
       UPDATE patient_password_reset_tokens t SET used_at = now()
        WHERE t.user_id IN (SELECT user_id FROM account) AND t.used_at IS NULL
     )
     INSERT INTO patient_password_reset_tokens (verifier, user_id, expires_at)
     SELECT $2, user_id, now() + make_interval(secs => $3::int) FROM account
     RETURNING expires_at`,
    [`${PATIENT_SUBJECT_PREFIX}${normalized}`, verifierOf(token), ttlSeconds],
  );
  const row = issued.rows[0];
  return row ? { token, expiresAt: row.expires_at } : null;
}

export type RedeemResetResult = { ok: true; userId: string } | { ok: false };

/**
 * Consumes a token and replaces the account password in ONE statement: the
 * token is claimed (single use, unexpired), the hash is swapped, the lockout is
 * cleared and every session of the account is revoked, or nothing changes. A
 * password-policy failure throws before the token is consumed.
 */
export async function redeemPatientPasswordReset(
  db: Queryable,
  token: string,
  newPassword: string,
): Promise<RedeemResetResult> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false };
  const verifier = verifierOf(token);
  const found = await db.query<{ auth_subject: string }>(
    `SELECT u.auth_subject
       FROM patient_password_reset_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.verifier = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
    [verifier],
  );
  const subject = found.rows[0]?.auth_subject;
  if (!subject) return { ok: false };
  validatePasswordPolicy(
    newPassword,
    subject.slice(PATIENT_SUBJECT_PREFIX.length),
  );
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(newPassword, salt, DEFAULT_PARAMS);
  const done = await db.query<{ user_id: string }>(
    `WITH claimed AS (
       UPDATE patient_password_reset_tokens SET used_at = now()
        WHERE verifier = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id
     ),
     changed AS (
       UPDATE patient_credentials c
          SET password_hash = $2, salt = $3, scrypt_n = $4, scrypt_r = $5,
              scrypt_p = $6, password_changed_at = now(), failed_attempts = 0,
              locked_until = NULL, updated_at = now()
         FROM claimed WHERE c.user_id = claimed.user_id
        RETURNING c.user_id
     ),
     revoked AS (
       UPDATE patient_sessions SET revoked_at = now()
        WHERE user_id IN (SELECT user_id FROM changed) AND revoked_at IS NULL
     )
     SELECT user_id FROM changed`,
    [
      verifier,
      hash,
      salt,
      DEFAULT_PARAMS.n,
      DEFAULT_PARAMS.r,
      DEFAULT_PARAMS.p,
    ],
  );
  const row = done.rows[0];
  return row ? { ok: true, userId: row.user_id } : { ok: false };
}
