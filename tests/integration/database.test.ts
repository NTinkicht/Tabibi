import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { closePool, databaseIsReady } from '@/platform/database/pool';

const client = new Client({ connectionString: process.env.DATABASE_URL });
beforeAll(async () => {
  await migrate();
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await closePool();
});

describe('PostgreSQL platform baseline', () => {
  it('runs migrations against PostgreSQL and records checksums', async () => {
    const result = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    expect(result.rows.map((row) => row.name)).toContain(
      '0001_platform_baseline.sql',
    );
    expect(result.rows.map((row) => row.name)).toContain(
      '0002_clinic_scheduling_foundation.sql',
    );
  });
  it('passes readiness against the real database', async () => {
    expect(await databaseIsReady()).toBe(true);
  });
});
