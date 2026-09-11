import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { getEnvironment } from '../../src/platform/config/env';

const migrationDirectory = resolve(process.cwd(), 'db/migrations');
const nonTransactionalMarker = '-- tabibi:no-transaction';

function runsWithoutTransaction(sql: string): boolean {
  return sql.split(/\r?\n/, 1)[0]?.trim() === nonTransactionalMarker;
}

async function runNonTransactionalMigration(
  client: Client,
  sql: string,
): Promise<void> {
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await client.query(statement);
}

export async function migrate(): Promise<void> {
  const client = new Client({
    connectionString: getEnvironment().DATABASE_URL,
  });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [730031]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(migrationDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const name of files) {
      const sql = await readFile(resolve(migrationDirectory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1',
        [name],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Applied migration was modified: ${name}`);
        continue;
      }
      const transactional = !runsWithoutTransaction(sql);
      if (transactional) await client.query('BEGIN');
      try {
        if (transactional) await client.query(sql);
        else await runNonTransactionalMigration(client, sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [name, checksum],
        );
        if (transactional) await client.query('COMMIT');
      } catch (error) {
        if (transactional) await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [730031]);
    await client.end();
  }
}
