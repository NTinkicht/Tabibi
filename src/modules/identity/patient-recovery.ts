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

type Connectable = Queryable & {
  connect?: () => Promise<unknown>;
  release?: unknown;
};

// A pool opens its own transaction on a dedicated connection. A client that is
// already checked out (it has release) is assumed to be inside the caller's
// transaction, which then owns commit and rollback.
async function inTransaction<T>(
  db: Connectable,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (!db.connect || db.release) return work(db);
  const client = (await db.connect()) as Queryable & { release: () => void };
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const verifierOf = (token: string): Buffer =>
  createHash('sha256').update(token, 'utf8').digest();

export type IssueResetResult = { token: string; expiresAt: Date } | null;

/**
 * Returns a fresh token for an existing patient account, or null when the email
 * is invalid or has no patient account (the caller answers identically either
 * way). Issuing supersedes every earlier unused token of the account.
 */
export async function issuePatientPasswordReset(
  db: Connectable,
  email: string,
  ttlSeconds: number = PATIENT_RESET_TOKEN_TTL_SECONDS,
): Promise<IssueResetResult> {
  const normalized = normalizePatientEmail(email);
  if (normalized === null) return null;
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const issued = await inTransaction(db, async (tx) => {
    // The credential row lock is taken in its own statement so the supersede and
    // insert below run on a fresh snapshot that sees any issuance that held the
    // lock first. Overlapping issuances for one account are serialized.
    const locked = await tx.query<{ user_id: string }>(
      `SELECT c.user_id
         FROM patient_credentials c JOIN users u ON u.id = c.user_id
        WHERE u.auth_subject = $1
          FOR UPDATE OF c`,
      [`${PATIENT_SUBJECT_PREFIX}${normalized}`],
    );
    const userId = locked.rows[0]?.user_id;
    if (!userId) return null;
    await tx.query(
      `UPDATE patient_password_reset_tokens SET used_at = now()
        WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    return tx.query<{ expires_at: Date }>(
      `INSERT INTO patient_password_reset_tokens (verifier, user_id, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3::int))
       RETURNING expires_at`,
      [verifierOf(token), userId, ttlSeconds],
    );
  });
  const row = issued?.rows[0];
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
  db: Connectable,
  token: string,
  newPassword: string,
): Promise<RedeemResetResult> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false };
  const verifier = verifierOf(token);
  const found = await db.query<{ auth_subject: string; user_id: string }>(
    `SELECT u.auth_subject, t.user_id
       FROM patient_password_reset_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.verifier = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
    [verifier],
  );
  const subject = found.rows[0]?.auth_subject;
  const accountId = found.rows[0]?.user_id;
  if (!subject || !accountId) return { ok: false };
  validatePasswordPolicy(
    newPassword,
    subject.slice(PATIENT_SUBJECT_PREFIX.length),
  );
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(newPassword, salt, DEFAULT_PARAMS);
  const done = await inTransaction(db, async (tx) => {
    // Wait for any in-flight sign-in (it holds FOR SHARE on this row) in a
    // statement of its own, so the statement below takes a fresh snapshot that
    // includes the session that sign-in committed and revokes it too.
    await tx.query(
      `SELECT 1 FROM patient_credentials WHERE user_id = $1 FOR UPDATE`,
      [accountId],
    );
    return tx.query<{ user_id: string }>(
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
  });
  const row = done.rows[0];
  return row ? { ok: true, userId: row.user_id } : { ok: false };
}
