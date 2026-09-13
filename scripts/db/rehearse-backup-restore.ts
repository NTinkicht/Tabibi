import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  assertDumpExists,
  assertRecoveryRehearsalAllowed,
  buildRehearsalDatabaseName,
  commandEnvironment,
  databaseUrlForDatabase,
  migrationMetadataMatches,
  parsePostgreSqlTarget,
  pgDumpArgs,
  pgRestoreArgs,
  quoteIdentifier,
  recoveryRehearsalCoreTables,
  rowCountsMatch,
} from './recovery-rehearsal-lib';

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? 'unknown'}`}`,
        ),
      );
    });
  });
}

async function readMigrationMetadata(client: Client) {
  const result = await client.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations ORDER BY name',
  );
  return result.rows;
}

async function readCoreTableCounts(client: Client) {
  const counts: Record<string, string> = {};
  for (const table of recoveryRehearsalCoreTables) {
    const exists = await client.query<{ relation: string | null }>(
      'SELECT to_regclass($1)::text AS relation',
      [`public.${table}`],
    );
    if (!exists.rows[0]?.relation) continue;
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${quoteIdentifier(table)}`,
    );
    counts[table] = result.rows[0]?.count ?? '0';
  }
  return counts;
}

async function main(): Promise<void> {
  assertRecoveryRehearsalAllowed(process.env);
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error('DATABASE_URL is required');

  const sourceTarget = parsePostgreSqlTarget(sourceUrl);
  const suffix = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const rehearsalDatabaseName = buildRehearsalDatabaseName(
    sourceTarget.databaseName,
    suffix,
  );
  const rehearsalUrl = databaseUrlForDatabase(sourceUrl, rehearsalDatabaseName);
  const rehearsalTarget = parsePostgreSqlTarget(rehearsalUrl);
  const adminUrl = databaseUrlForDatabase(sourceUrl, 'postgres');

  if (rehearsalTarget.databaseName === sourceTarget.databaseName) {
    throw new Error('Refusing to restore over the source database');
  }

  const workingDirectory = await mkdtemp(
    join(tmpdir(), 'tabibi-recovery-rehearsal-'),
  );
  const dumpPath = join(workingDirectory, 'tabibi.dump');
  const sourceClient = new Client({ connectionString: sourceUrl });
  const adminClient = new Client({ connectionString: adminUrl });
  let rehearsalClient: Client | null = null;
  let adminConnected = false;
  let targetCreated = false;

  try {
    await sourceClient.connect();
    const sourceMigrations = await readMigrationMetadata(sourceClient);
    const sourceCounts = await readCoreTableCounts(sourceClient);

    await runCommand(
      'pg_dump',
      pgDumpArgs(sourceTarget, dumpPath),
      commandEnvironment(process.env, sourceTarget),
    );
    await assertDumpExists(dumpPath);

    await adminClient.connect();
    adminConnected = true;
    const existing = await adminClient.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [rehearsalDatabaseName],
    );
    if (existing.rowCount) {
      throw new Error(
        'Generated rehearsal database already exists; refusing to reuse it',
      );
    }
    await adminClient.query(
      `CREATE DATABASE ${quoteIdentifier(rehearsalDatabaseName)}`,
    );
    targetCreated = true;

    await runCommand(
      'pg_restore',
      pgRestoreArgs(rehearsalTarget, dumpPath),
      commandEnvironment(process.env, rehearsalTarget),
    );

    rehearsalClient = new Client({ connectionString: rehearsalUrl });
    await rehearsalClient.connect();
    const restoredMigrations = await readMigrationMetadata(rehearsalClient);
    const restoredCounts = await readCoreTableCounts(rehearsalClient);

    if (!migrationMetadataMatches(sourceMigrations, restoredMigrations)) {
      throw new Error('Restored migration metadata does not match the source');
    }
    if (!rowCountsMatch(sourceCounts, restoredCounts)) {
      throw new Error('Restored core-table row counts do not match the source');
    }

    process.stdout.write(
      `Database recovery rehearsal passed: ${sourceMigrations.length} migrations and ${Object.keys(sourceCounts).length} bounded table counts verified.\n`,
    );
  } finally {
    if (rehearsalClient) await rehearsalClient.end().catch(() => undefined);
    await sourceClient.end().catch(() => undefined);
    if (targetCreated && adminConnected) {
      await adminClient
        .query(
          `DROP DATABASE ${quoteIdentifier(rehearsalDatabaseName)} WITH (FORCE)`,
        )
        .catch(() => undefined);
    }
    if (adminConnected) await adminClient.end().catch(() => undefined);
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : 'Unknown recovery rehearsal error';
  console.error(`Database recovery rehearsal failed: ${message}`);
  process.exitCode = 1;
});
