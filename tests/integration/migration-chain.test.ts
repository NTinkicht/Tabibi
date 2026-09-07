import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';

const client = new Client({ connectionString: process.env.DATABASE_URL });
const committedMigrations = [
  '0001_platform_baseline.sql',
  '0002_clinic_scheduling_foundation.sql',
  '0003_session_operations.sql',
  '0004_walkin_queue_foundation.sql',
  '0005_queue_lifecycle.sql',
  '0006_queue_priority_order.sql',
  '0007_waiting_room_public_labels.sql',
];

beforeAll(async () => {
  await migrate();
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe('committed migration chain', () => {
  it('applies every committed migration through the real migrator and re-runs as a no-op', async () => {
    await migrate();
    const applied = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    expect(applied.rows.map((row) => row.name)).toEqual(committedMigrations);

    await migrate();
    const rerun = await client.query<{ count: string }>(
      'SELECT count(*)::text count FROM schema_migrations',
    );
    expect(rerun.rows[0]!.count).toBe(String(committedMigrations.length));
  });

  it('exposes queue lifecycle and stale-version artifacts created by later migrations', async () => {
    const artifacts = await client.query<{
      queue_order_version: string;
      reorder_receipts: string | null;
      priority_selection_idx: string | null;
      one_called_idx: string | null;
      one_consultation_idx: string | null;
    }>(
      `SELECT
         EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_name = 'consultation_sessions'
              AND column_name = 'queue_order_version'
         )::text queue_order_version,
         to_regclass('queue_reorder_receipts')::text reorder_receipts,
         to_regclass('queue_entries_session_priority_selection_idx')::text priority_selection_idx,
         to_regclass('queue_entries_one_called_per_session_uq')::text one_called_idx,
         to_regclass('queue_entries_one_consultation_per_session_uq')::text one_consultation_idx`,
    );

    expect(artifacts.rows[0]).toEqual({
      queue_order_version: 'true',
      reorder_receipts: 'queue_reorder_receipts',
      priority_selection_idx: 'queue_entries_session_priority_selection_idx',
      one_called_idx: 'queue_entries_one_called_per_session_uq',
      one_consultation_idx: 'queue_entries_one_consultation_per_session_uq',
    });
  });
});
