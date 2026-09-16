import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountDependentNotFoundError,
  AccountDependentService,
  AccountDependentValidationError,
  normalizeDependentDisplayName,
} from '@/modules/account-dependent';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const ownerA = randomUUID();
const ownerB = randomUUID();

beforeAll(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE patient_dependents, users CASCADE');
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'wu69-owner-a', 'Owner A'),
       ($2, 'wu69-owner-b', 'Owner B')`,
    [ownerA, ownerB],
  );
});
afterAll(() => pool.end());

const scopeA = { ownerUserId: ownerA };
const scopeB = { ownerUserId: ownerB };

describe('WU69 account-owned dependent foundation', () => {
  it('creates and lists only caller-owned privacy-safe dependents with NFC-normalized Arabic/French names', async () => {
    const service = new AccountDependentService(pool);
    const french = await service.create(scopeA, {
      displayName: '  E\u0301lodie Benali  ',
    });
    const arabic = await service.create(scopeA, {
      displayName: '  ليلى بن علي  ',
    });
    await service.create(scopeB, { displayName: 'Other Account' });

    expect(french.displayName).toBe('Élodie Benali');
    expect(arabic.displayName).toBe('ليلى بن علي');
    expect(await service.list(scopeA)).toEqual(
      expect.arrayContaining([french, arabic]),
    );
    expect(await service.list(scopeA)).toHaveLength(2);
    expect(await service.list(scopeB)).toHaveLength(1);

    for (const dependent of await service.list(scopeA)) {
      expect(Object.keys(dependent).sort()).toEqual(
        [
          'archivedAt',
          'createdAt',
          'displayName',
          'id',
          'status',
          'updatedAt',
        ].sort(),
      );
    }
    expect(JSON.stringify(await service.list(scopeA))).not.toContain(ownerA);
    expect(JSON.stringify(await service.list(scopeA))).not.toContain(ownerB);
  });

  it('makes cross-account reads and mutations indistinguishable from unknown dependents', async () => {
    const service = new AccountDependentService(pool);
    const dependent = await service.create(scopeA, { displayName: 'Amine' });
    const unknown = randomUUID();

    for (const id of [dependent.id, unknown, 'not-a-uuid']) {
      await expect(service.get(scopeB, id)).rejects.toBeInstanceOf(
        AccountDependentNotFoundError,
      );
      await expect(
        service.update(scopeB, id, { displayName: 'Changed' }),
      ).rejects.toBeInstanceOf(AccountDependentNotFoundError);
      await expect(service.archive(scopeB, id)).rejects.toBeInstanceOf(
        AccountDependentNotFoundError,
      );
    }

    expect(await service.get(scopeA, dependent.id)).toEqual(dependent);
  });

  it('archives idempotently and excludes archived dependents from active operations', async () => {
    const service = new AccountDependentService(pool);
    const dependent = await service.create(scopeA, { displayName: 'Nour' });

    const archived = await service.archive(scopeA, dependent.id);
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).not.toBeNull();
    expect(await service.archive(scopeA, dependent.id)).toEqual(archived);

    await expect(service.get(scopeA, dependent.id)).rejects.toBeInstanceOf(
      AccountDependentNotFoundError,
    );
    await expect(
      service.getActiveForOperation(scopeA, dependent.id),
    ).rejects.toBeInstanceOf(AccountDependentNotFoundError);
    await expect(
      service.update(scopeA, dependent.id, { displayName: 'Nour Updated' }),
    ).rejects.toBeInstanceOf(AccountDependentNotFoundError);

    expect(await service.list(scopeA)).toEqual([]);
    expect(await service.list(scopeA, { includeArchived: true })).toEqual([
      archived,
    ]);
    expect(
      await service.get(scopeA, dependent.id, { includeArchived: true }),
    ).toEqual(archived);
  });

  it('rejects unsafe text and enforces NFC at both service and PostgreSQL boundaries', async () => {
    expect(normalizeDependentDisplayName('  Franc\u0327ois  ')).toBe(
      'François',
    );
    expect(normalizeDependentDisplayName('  أحمد  ')).toBe('أحمد');
    expect(normalizeDependentDisplayName('\u00A0Amine\u00A0')).toBe('Amine');
    expect(() => normalizeDependentDisplayName('')).toThrow(
      AccountDependentValidationError,
    );
    expect(() => normalizeDependentDisplayName('   ')).toThrow(
      AccountDependentValidationError,
    );
    expect(() => normalizeDependentDisplayName('\u00A0')).toThrow(
      AccountDependentValidationError,
    );
    expect(() => normalizeDependentDisplayName('Ali\u0000')).toThrow(
      AccountDependentValidationError,
    );
    expect(() => normalizeDependentDisplayName('Ali\u200B')).toThrow(
      AccountDependentValidationError,
    );
    expect(() => normalizeDependentDisplayName('x'.repeat(161))).toThrow(
      AccountDependentValidationError,
    );

    for (const displayName of ['E\u0301lodie', 'Ali\u200B']) {
      await expect(
        pool.query(
          `INSERT INTO patient_dependents (id, owner_user_id, display_name)
           VALUES ($1,$2,$3)`,
          [randomUUID(), ownerA, displayName],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('keeps the storage schema free of clinical/contact/account-display leakage fields', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name='patient_dependents'
        ORDER BY column_name`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'owner_user_id',
        'display_name',
        'status',
        'created_at',
        'updated_at',
        'archived_at',
      ]),
    );
    expect(names.join(' ')).not.toMatch(
      /diagnos|medication|clinical|government|address|phone|email|contact|birth|dob|token|credential|secret/,
    );
  });
});
