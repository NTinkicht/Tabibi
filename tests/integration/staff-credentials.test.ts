import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  PasswordPolicyError,
  StaffCredentialUserNotFoundError,
  setStaffPassword,
  verifyStaffPassword,
} from '@/modules/identity/staff-credentials';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const alice = randomUUID();
const SUBJECT = 'alice@credentials.example';
const GOOD = 'correct horse battery';

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE staff_credentials, users CASCADE');
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES ($1,$2,'Alice')`,
    [alice, SUBJECT],
  );
});

async function state() {
  const r = await pool.query<{
    failed_attempts: number;
    locked_until: Date | null;
  }>('SELECT failed_attempts, locked_until FROM staff_credentials');
  return r.rows[0]!;
}

describe('staff credentials (#723)', () => {
  it('stores only a salted scrypt hash with its parameters, never the password', async () => {
    await setStaffPassword(pool, alice, GOOD);
    const row = (await pool.query('SELECT * FROM staff_credentials')).rows[0];
    expect(row.scrypt_n).toBe(32768);
    expect(row.scrypt_r).toBe(8);
    expect(row.scrypt_p).toBe(1);
    expect(row.password_hash).toHaveLength(32);
    expect(row.salt.length).toBeGreaterThanOrEqual(16);
    expect(JSON.stringify(row)).not.toContain(GOOD);
    expect(row.password_hash.toString('utf8')).not.toContain(GOOD);
    await setStaffPassword(pool, alice, GOOD);
    const again = (await pool.query('SELECT salt FROM staff_credentials'))
      .rows[0];
    expect(again.salt.equals(row.salt)).toBe(false);
  });

  it('verifies the right password and rejects wrong, unknown and locked identically', async () => {
    await setStaffPassword(pool, alice, GOOD);
    expect(await verifyStaffPassword(pool, SUBJECT, GOOD)).toEqual({
      ok: true,
      userId: alice,
    });
    const wrong = await verifyStaffPassword(pool, SUBJECT, 'wrong password!!');
    const unknown = await verifyStaffPassword(pool, 'nobody@x.example', GOOD);
    expect(wrong).toEqual({ ok: false });
    expect(unknown).toEqual(wrong);
  });

  it('enforces the password policy and a missing user without echoing the password', async () => {
    await expect(setStaffPassword(pool, alice, 'short')).rejects.toBeInstanceOf(
      PasswordPolicyError,
    );
    await expect(
      setStaffPassword(pool, alice, 'ALICE@credentials.example'),
    ).rejects.toMatchObject({ code: 'matches_identity' });
    await expect(
      setStaffPassword(pool, randomUUID(), GOOD),
    ).rejects.toBeInstanceOf(StaffCredentialUserNotFoundError);
    expect((await pool.query('SELECT 1 FROM staff_credentials')).rowCount).toBe(
      0,
    );
  });

  it('locks after N consecutive failures, refuses the right password while locked, and resets on success', async () => {
    await setStaffPassword(pool, alice, GOOD);
    const opts = { maxFailedAttempts: 3, lockoutSeconds: 60 };
    for (let i = 0; i < 2; i++)
      await verifyStaffPassword(pool, SUBJECT, 'wrong password!!', opts);
    expect((await state()).failed_attempts).toBe(2);
    expect(await verifyStaffPassword(pool, SUBJECT, GOOD, opts)).toMatchObject({
      ok: true,
    });
    expect((await state()).failed_attempts).toBe(0);
    for (let i = 0; i < 3; i++)
      await verifyStaffPassword(pool, SUBJECT, 'wrong password!!', opts);
    const locked = await state();
    expect(locked.locked_until!.getTime()).toBeGreaterThan(Date.now());
    expect(await verifyStaffPassword(pool, SUBJECT, GOOD, opts)).toEqual({
      ok: false,
    });
    await verifyStaffPassword(pool, SUBJECT, 'wrong password!!', opts);
    expect((await state()).locked_until!.getTime()).toBe(
      locked.locked_until!.getTime(),
    );
  });

  it('accepts the right password again once the lock has expired, and restarts the counter', async () => {
    await setStaffPassword(pool, alice, GOOD);
    const opts = { maxFailedAttempts: 2, lockoutSeconds: 60 };
    for (let i = 0; i < 2; i++)
      await verifyStaffPassword(pool, SUBJECT, 'wrong password!!', opts);
    await pool.query(
      `UPDATE staff_credentials SET locked_until = now() - interval '1 second'`,
    );
    await verifyStaffPassword(pool, SUBJECT, 'wrong password!!', opts);
    expect((await state()).failed_attempts).toBe(1);
    expect((await state()).locked_until).toBeNull();
    expect(await verifyStaffPassword(pool, SUBJECT, GOOD, opts)).toMatchObject({
      ok: true,
    });
  });

  it('cannot bypass the limit with parallel attempts, including a parallel correct password', async () => {
    await setStaffPassword(pool, alice, GOOD);
    const opts = { maxFailedAttempts: 5, lockoutSeconds: 300 };
    const guesses = Array.from({ length: 10 }, (_, i) =>
      verifyStaffPassword(pool, SUBJECT, `wrong password ${i}!`, opts),
    );
    await Promise.all(guesses);
    const s = await state();
    expect(s.failed_attempts).toBe(5);
    expect(s.locked_until).not.toBeNull();
    const race = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) =>
        verifyStaffPassword(pool, SUBJECT, `other wrong ${i}!!`, opts),
      ),
      verifyStaffPassword(pool, SUBJECT, GOOD, opts),
    ]);
    expect(race.every((r) => r.ok === false)).toBe(true);
  });

  it('never exposes hash material through results or errors', async () => {
    await setStaffPassword(pool, alice, GOOD);
    const result = await verifyStaffPassword(pool, SUBJECT, GOOD);
    expect(Object.keys(result).sort()).toEqual(['ok', 'userId']);
    const fail = await verifyStaffPassword(pool, SUBJECT, 'nope nope nope!');
    expect(Object.keys(fail)).toEqual(['ok']);
  });

  it('rejects an invalid lockout configuration', async () => {
    await expect(
      verifyStaffPassword(pool, SUBJECT, GOOD, { maxFailedAttempts: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
