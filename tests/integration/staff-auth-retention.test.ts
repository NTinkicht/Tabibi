import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  STAFF_AUTH_RETENTION_MS,
  purgeExpiredStaffAuthArtifacts,
} from '@/modules/identity/staff-auth-retention';

// TAB-P0-15: expired staff sessions and dead invites are purged after a grace.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const NOW = new Date('2026-06-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const OLD = STAFF_AUTH_RETENTION_MS + DAY;
const ids = { user: randomUUID(), clinic: randomUUID() };

const addSession = (expiresAgo: number, revokedAgo: number | null = null) =>
  pool.query(
    `INSERT INTO staff_sessions (verifier, user_id, issued_at, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      randomBytes(32),
      ids.user,
      ago(Math.max(expiresAgo, revokedAgo ?? 0) + 60 * DAY),
      ago(expiresAgo),
      revokedAgo === null ? null : ago(revokedAgo),
    ],
  );
let inviteSeq = 0;
const addInvite = (
  expiresAgo: number,
  state: { revokedAgo?: number; accepted?: boolean } = {},
) => {
  inviteSeq += 1;
  return pool.query(
    `INSERT INTO staff_invites (id, clinic_id, email, role, token_verifier, invited_by,
                                expires_at, revoked_at, accepted_at, accepted_user_id, created_at)
     VALUES ($1, $2, $3, 'receptionist', $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      ids.clinic,
      `invitee${inviteSeq}@example.test`,
      randomBytes(32),
      ids.user,
      ago(expiresAgo),
      state.revokedAgo === undefined ? null : ago(state.revokedAgo),
      state.accepted ? ago(expiresAgo + 2 * DAY) : null,
      state.accepted ? ids.user : null,
      ago(Math.max(expiresAgo, state.revokedAgo ?? 0) + 60 * DAY),
    ],
  );
};
const count = async (table: string) =>
  Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  await pool.query('TRUNCATE staff_invites, clinics, users CASCADE');
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES ($1,'staff-retention','S')`,
    [ids.user],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES ($1,'staff-retention','Clinic')`,
    [ids.clinic],
  );
});
afterAll(async () => {
  await pool.end();
});

describe('purgeExpiredStaffAuthArtifacts', () => {
  it('deletes long-dead sessions and invites and keeps live, recent and accepted ones', async () => {
    await addSession(OLD); // expired long ago: purged
    await addSession(-DAY * 30, OLD); // live expiry but revoked long ago: purged
    await addSession(-DAY); // live: kept
    await addSession(2 * DAY); // expired recently: kept
    await addSession(-DAY, 2 * DAY); // revoked recently: kept
    await addInvite(OLD); // expired long ago, never accepted: purged
    await addInvite(-DAY * 30, { revokedAgo: OLD }); // revoked long ago: purged
    await addInvite(-DAY); // open and live: kept
    await addInvite(2 * DAY); // expired recently: kept
    await addInvite(-DAY, { revokedAgo: 2 * DAY }); // revoked recently: kept
    await addInvite(OLD, { accepted: true }); // accepted long ago: kept as a record
    expect(await purgeExpiredStaffAuthArtifacts(pool, NOW)).toEqual({
      sessions: 2,
      invites: 2,
    });
    expect(await count('staff_sessions')).toBe(3);
    expect(await count('staff_invites')).toBe(4);
    // Idempotent: nothing further to purge.
    expect(await purgeExpiredStaffAuthArtifacts(pool, NOW)).toEqual({
      sessions: 0,
      invites: 0,
    });
  });

  it('deletes only the due rows, keeping the grace boundary row', async () => {
    await addSession(STAFF_AUTH_RETENTION_MS); // exactly at cutoff: due
    await addSession(STAFF_AUTH_RETENTION_MS - 1_000); // just inside grace: kept
    expect(await purgeExpiredStaffAuthArtifacts(pool, NOW)).toEqual({
      sessions: 1,
      invites: 0,
    });
    expect(await count('staff_sessions')).toBe(1);
  });

  it('bounds one run to a batch and finishes over repeated runs', async () => {
    await pool.query(
      `INSERT INTO staff_sessions (verifier, user_id, issued_at, expires_at)
       SELECT sha256(convert_to(n::text, 'UTF8')), $1, $2, $3 FROM generate_series(1, 520) AS n`,
      [ids.user, ago(OLD + DAY), ago(OLD)],
    );
    expect((await purgeExpiredStaffAuthArtifacts(pool, NOW)).sessions).toBe(
      500,
    );
    expect((await purgeExpiredStaffAuthArtifacts(pool, NOW)).sessions).toBe(20);
    expect(await count('staff_sessions')).toBe(0);
  });
});
