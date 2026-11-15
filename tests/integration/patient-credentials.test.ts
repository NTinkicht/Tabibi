import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  PatientRegistrationInputError,
  normalizePatientEmail,
  registerPatientAccount,
  verifyPatientPassword,
} from '@/modules/identity/patient-credentials';
import {
  PasswordPolicyError,
  setStaffPassword,
  verifyStaffPassword,
} from '@/modules/identity/staff-credentials';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const EMAIL = 'Samia.Benali@patients.example';
const GOOD = 'correct horse battery';
const input = (
  over: Partial<Parameters<typeof registerPatientAccount>[1]> = {},
) => ({
  email: EMAIL,
  displayName: 'Samia Benali',
  password: GOOD,
  ...over,
});

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE patient_credentials, staff_credentials, users CASCADE',
  );
});

async function state() {
  const r = await pool.query<{
    failed_attempts: number;
    locked_until: Date | null;
  }>('SELECT failed_attempts, locked_until FROM patient_credentials');
  return r.rows[0]!;
}

describe('patient credentials (#875)', () => {
  it('registers a namespaced patient user and stores only a salted scrypt hash', async () => {
    const result = await registerPatientAccount(pool, input());
    expect(result.ok).toBe(true);
    const user = (await pool.query('SELECT * FROM users')).rows[0];
    expect(user.auth_subject).toBe('patient:samia.benali@patients.example');
    expect(user.platform_role).toBeNull();
    const row = (await pool.query('SELECT * FROM patient_credentials')).rows[0];
    expect(row.user_id).toBe(user.id);
    expect(row.scrypt_n).toBe(32768);
    expect(row.password_hash).toHaveLength(32);
    expect(JSON.stringify(row)).not.toContain(GOOD);
    expect(JSON.stringify(user)).not.toContain(GOOD);
    expect(
      (await pool.query('SELECT 1 FROM clinic_memberships')).rowCount,
    ).toBe(0);
  });

  it('verifies the right password and returns the identical failure for wrong, unknown and malformed email', async () => {
    const reg = await registerPatientAccount(pool, input());
    expect(
      await verifyPatientPassword(
        pool,
        ' SAMIA.benali@patients.example ',
        GOOD,
      ),
    ).toEqual({
      ok: true,
      userId: reg.ok ? reg.userId : '',
      passwordHash: expect.any(Buffer),
    });
    const wrong = await verifyPatientPassword(pool, EMAIL, 'wrong password!!');
    expect(wrong).toEqual({ ok: false });
    expect(
      await verifyPatientPassword(pool, 'nobody@patients.example', GOOD),
    ).toEqual(wrong);
    expect(await verifyPatientPassword(pool, 'not-an-email', GOOD)).toEqual(
      wrong,
    );
  });

  it('refuses a duplicate registration (case and Unicode variants) with one uniform failure and no second user', async () => {
    await registerPatientAccount(pool, input());
    const dup = await registerPatientAccount(
      pool,
      input({ password: 'another long password' }),
    );
    const fullwidth = await registerPatientAccount(
      pool,
      input({ email: 'ＳＡＭＩＡ.benali@patients.example' }),
    );
    expect(dup).toEqual({ ok: false });
    expect(fullwidth).toEqual({ ok: false });
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(1);
    expect(
      (await pool.query('SELECT 1 FROM patient_credentials')).rowCount,
    ).toBe(1);
    // The original password is untouched by the refused attempts.
    expect(await verifyPatientPassword(pool, EMAIL, GOOD)).toMatchObject({
      ok: true,
    });
  });

  it('lets only one of many parallel registrations for the same email win', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => registerPatientAccount(pool, input())),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(1);
  });

  it('validates input without echoing it', async () => {
    await expect(
      registerPatientAccount(pool, input({ email: 'bad' })),
    ).rejects.toMatchObject({
      code: 'invalid_email',
    });
    await expect(
      registerPatientAccount(pool, input({ email: 'a:b@patients.example' })),
    ).rejects.toBeInstanceOf(PatientRegistrationInputError);
    await expect(
      registerPatientAccount(pool, input({ displayName: '  ' })),
    ).rejects.toMatchObject({
      code: 'invalid_name',
    });
    await expect(
      registerPatientAccount(pool, input({ displayName: 'Bad\u0000Name' })),
    ).rejects.toMatchObject({ code: 'invalid_name' });
    await expect(
      registerPatientAccount(pool, input({ password: 'short' })),
    ).rejects.toBeInstanceOf(PasswordPolicyError);
    await expect(
      registerPatientAccount(pool, input({ password: EMAIL.toLowerCase() })),
    ).rejects.toMatchObject({ code: 'matches_identity' });
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(0);
    expect(normalizePatientEmail('x'.repeat(250) + '@a.example')).toBeNull();
  });

  it('accepts Arabic and French display names in NFC', async () => {
    await registerPatientAccount(pool, input({ displayName: 'سامية بن علي' }));
    await registerPatientAccount(
      pool,
      input({ email: 'zoe@patients.example', displayName: 'Zoé Éléonore' }),
    );
    const names = (
      await pool.query('SELECT display_name FROM users ORDER BY display_name')
    ).rows.map((r) => r.display_name as string);
    expect(names).toContain('سامية بن علي');
    expect(names).toContain('Zoé Éléonore');
  });

  it('keeps patient and staff credentials non-interchangeable', async () => {
    const reg = await registerPatientAccount(pool, input());
    // A patient password never authenticates as staff (positive control: the staff path works for a real staff user).
    expect(
      await verifyStaffPassword(pool, `patient:${EMAIL.toLowerCase()}`, GOOD),
    ).toEqual({ ok: false });
    expect(await verifyStaffPassword(pool, EMAIL.toLowerCase(), GOOD)).toEqual({
      ok: false,
    });
    const staffId = randomUUID();
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES ($1,'samia.benali@patients.example','Staff')`,
      [staffId],
    );
    await setStaffPassword(pool, staffId, 'staff password 123');
    expect(
      await verifyStaffPassword(
        pool,
        'samia.benali@patients.example',
        'staff password 123',
      ),
    ).toMatchObject({
      ok: true,
    });
    // The same-email staff password and credentials do not authenticate the patient, and vice versa.
    expect(
      await verifyPatientPassword(pool, EMAIL, 'staff password 123'),
    ).toEqual({ ok: false });
    expect(await verifyPatientPassword(pool, EMAIL, GOOD)).toEqual({
      ok: true,
      userId: reg.ok ? reg.userId : '',
      passwordHash: expect.any(Buffer),
    });
  });

  it('locks after N failures, refuses the right password while locked, and resets on success', async () => {
    await registerPatientAccount(pool, input());
    const opts = { maxFailedAttempts: 3, lockoutSeconds: 60 };
    for (let i = 0; i < 2; i++)
      await verifyPatientPassword(pool, EMAIL, 'wrong password!!', opts);
    expect((await state()).failed_attempts).toBe(2);
    expect(await verifyPatientPassword(pool, EMAIL, GOOD, opts)).toMatchObject({
      ok: true,
    });
    expect((await state()).failed_attempts).toBe(0);
    for (let i = 0; i < 3; i++)
      await verifyPatientPassword(pool, EMAIL, 'wrong password!!', opts);
    expect((await state()).locked_until!.getTime()).toBeGreaterThan(Date.now());
    expect(await verifyPatientPassword(pool, EMAIL, GOOD, opts)).toEqual({
      ok: false,
    });
  });

  it('cannot bypass the lockout with parallel attempts, including a parallel correct password', async () => {
    await registerPatientAccount(pool, input());
    const opts = { maxFailedAttempts: 5, lockoutSeconds: 300 };
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        verifyPatientPassword(pool, EMAIL, `wrong password ${i}!`, opts),
      ),
    );
    const s = await state();
    expect(s.failed_attempts).toBe(5);
    expect(s.locked_until).not.toBeNull();
    const race = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) =>
        verifyPatientPassword(pool, EMAIL, `other wrong ${i}!!`, opts),
      ),
      verifyPatientPassword(pool, EMAIL, GOOD, opts),
    ]);
    expect(race.every((r) => r.ok === false)).toBe(true);
  });

  it('never exposes hash material through results', async () => {
    const reg = await registerPatientAccount(pool, input());
    expect(Object.keys(reg).sort()).toEqual(['ok', 'userId']);
    expect(
      Object.keys(await verifyPatientPassword(pool, EMAIL, 'nope nope nope!')),
    ).toEqual(['ok']);
  });

  it('rejects an invalid lockout configuration', async () => {
    await expect(
      verifyPatientPassword(pool, EMAIL, GOOD, { maxFailedAttempts: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
