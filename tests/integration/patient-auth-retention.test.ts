import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { registerPatientAccount } from '@/modules/identity/patient-credentials';
import {
  PATIENT_AUTH_RETENTION_MS,
  purgeExpiredPatientAuthArtifacts,
} from '@/modules/identity/patient-auth-retention';

// TAB-P0-15: expired patient sessions and reset tokens are purged after a grace.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const NOW = new Date('2026-06-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const EMAILS = ['leila.patient@example.test', 'karim.patient@example.test'];
let users: string[] = [];

const addSession = (
  user: string,
  expiresAgo: number,
  revokedAgo: number | null = null,
) =>
  pool.query(
    `INSERT INTO patient_sessions (verifier, user_id, issued_at, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      randomBytes(32),
      user,
      ago(Math.max(expiresAgo, revokedAgo ?? 0) + 60 * DAY),
      ago(expiresAgo),
      revokedAgo === null ? null : ago(revokedAgo),
    ],
  );
const addToken = (user: string, expiresAgo: number, usedAgo: number | null) =>
  pool.query(
    `INSERT INTO patient_password_reset_tokens (verifier, user_id, created_at, expires_at, used_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      randomBytes(32),
      user,
      ago(expiresAgo + DAY),
      ago(expiresAgo),
      usedAgo === null ? null : ago(usedAgo),
    ],
  );
const count = async (table: string) =>
  Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'patient-retention-secret-at-least-32-characters';
  await migrate();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE patient_credentials, users CASCADE`);
  users = [];
  for (const email of EMAILS) {
    await registerPatientAccount(pool, {
      email,
      displayName: 'P',
      password: 'correct horse battery',
    });
    users.push(
      (
        await pool.query('SELECT id FROM users WHERE auth_subject = $1', [
          `patient:${email}`,
        ])
      ).rows[0].id,
    );
  }
});
afterAll(async () => {
  await pool.end();
});

describe('purgeExpiredPatientAuthArtifacts', () => {
  it('deletes long-dead sessions and tokens and keeps live and recent ones', async () => {
    const old = PATIENT_AUTH_RETENTION_MS + DAY;
    for (const user of users) {
      await addSession(user, old); // expired long ago: purged
      await addSession(user, -DAY * 30, old); // live expiry but revoked long ago: purged
      await addSession(user, -DAY); // live: kept
      await addSession(user, 2 * DAY); // expired recently: kept
      await addSession(user, -DAY, 2 * DAY); // revoked recently: kept
      await addToken(user, old, null); // expired long ago: purged
      await addToken(user, -DAY, old); // used long ago: purged
      await addToken(user, -DAY, null); // live: kept
      await addToken(user, 2 * DAY, null); // expired recently: kept
      await addToken(user, -DAY, 2 * DAY); // used recently: kept
    }
    expect(await purgeExpiredPatientAuthArtifacts(pool, NOW)).toEqual({
      sessions: 4,
      resetTokens: 4,
    });
    expect(await count('patient_sessions')).toBe(6);
    expect(await count('patient_password_reset_tokens')).toBe(6);
    // Idempotent: nothing further to purge.
    expect(await purgeExpiredPatientAuthArtifacts(pool, NOW)).toEqual({
      sessions: 0,
      resetTokens: 0,
    });
  });

  it('deletes only the due rows, keeping the grace boundary row', async () => {
    await addSession(users[0], PATIENT_AUTH_RETENTION_MS); // exactly at cutoff: due
    await addSession(users[0], PATIENT_AUTH_RETENTION_MS - 1_000); // just inside grace: kept
    expect(await purgeExpiredPatientAuthArtifacts(pool, NOW)).toEqual({
      sessions: 1,
      resetTokens: 0,
    });
    expect(await count('patient_sessions')).toBe(1);
  });

  it('bounds one run to a batch and finishes over repeated runs', async () => {
    const old = PATIENT_AUTH_RETENTION_MS + DAY;
    await pool.query(
      `INSERT INTO patient_sessions (verifier, user_id, issued_at, expires_at)
       SELECT sha256(convert_to(n::text, 'UTF8')), $1, $2, $3 FROM generate_series(1, 520) AS n`,
      [users[0], ago(old + DAY), ago(old)],
    );
    expect((await purgeExpiredPatientAuthArtifacts(pool, NOW)).sessions).toBe(
      500,
    );
    expect((await purgeExpiredPatientAuthArtifacts(pool, NOW)).sessions).toBe(
      20,
    );
    expect(await count('patient_sessions')).toBe(0);
  });
});
