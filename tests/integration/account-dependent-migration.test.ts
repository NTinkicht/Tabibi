import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

beforeAll(migrate);
afterAll(() => pool.end());

describe('WU69 dependent migration artifacts', () => {
  it('installs the dependent enum, table, owner indexes, foreign key and lifecycle/name constraints', async () => {
    const artifacts = await pool.query<{
      dependent_status: string | null;
      dependents_table: string | null;
      owner_status_name_idx: string | null;
      owner_updated_idx: string | null;
      owner_fk_count: number;
      check_definitions: string;
    }>(
      `SELECT
         to_regtype('dependent_status')::text dependent_status,
         to_regclass('patient_dependents')::text dependents_table,
         to_regclass('patient_dependents_owner_status_name_idx')::text owner_status_name_idx,
         to_regclass('patient_dependents_owner_updated_idx')::text owner_updated_idx,
         (SELECT count(*)::int
            FROM pg_constraint
           WHERE conrelid='patient_dependents'::regclass
             AND contype='f') owner_fk_count,
         (SELECT string_agg(pg_get_constraintdef(oid), E'\n' ORDER BY conname)
            FROM pg_constraint
           WHERE conrelid='patient_dependents'::regclass
             AND contype='c') check_definitions`,
    );

    const row = artifacts.rows[0]!;
    expect(row).toMatchObject({
      dependent_status: 'dependent_status',
      dependents_table: 'patient_dependents',
      owner_status_name_idx: 'patient_dependents_owner_status_name_idx',
      owner_updated_idx: 'patient_dependents_owner_updated_idx',
      owner_fk_count: 1,
    });
    expect(row.check_definitions).toContain('display_name IS NFC NORMALIZED');
    expect(row.check_definitions).toContain('char_length(display_name)');
    expect(row.check_definitions).toContain('status');
    expect(row.check_definitions).toContain('archived_at');
  });

  it('keeps migration 0029 rerunnable through the normal migration ledger', async () => {
    await migrate();
    await migrate();
    const applied = await pool.query<{ count: number }>(
      `SELECT count(*)::int count
         FROM schema_migrations
        WHERE name='0029_account_owned_dependents.sql'`,
    );
    expect(applied.rows[0]?.count).toBe(1);
  });

  it('rejects direct storage writes that bypass canonical Unicode edge trimming', async () => {
    const ownerUserId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name)
       VALUES ($1,$2,'WU69 Migration Owner')`,
      [ownerUserId, `wu69-migration-owner-${ownerUserId}`],
    );

    for (const displayName of ['\u00A0', '\u00A0Amine\u00A0']) {
      await expect(
        pool.query(
          `INSERT INTO patient_dependents (id, owner_user_id, display_name)
           VALUES ($1,$2,$3)`,
          [randomUUID(), ownerUserId, displayName],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });
});
