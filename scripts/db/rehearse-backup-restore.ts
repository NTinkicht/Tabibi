import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  assertDumpExists,
  assertNonProductionSourceDatabase,
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

let activeChild: ChildProcess | null = null;
let terminationSignal: NodeJS.Signals | null = null;

function throwIfTerminationRequested(): void {
  if (terminationSignal) {
    throw new Error(
      `Database recovery rehearsal interrupted by ${terminationSignal}; cleanup was attempted`,
    );
  }
}

function installTerminationHandlers(): () => void {
  const requestTermination = (signal: NodeJS.Signals) => {
    terminationSignal ??= signal;
    if (activeChild && !activeChild.killed) {
      activeChild.kill(signal);
    }
  };
  const onSigint = () => requestTermination('SIGINT');
  const onSigterm = () => requestTermination('SIGTERM');

  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return () => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  throwIfTerminationRequested();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    activeChild = child;

    // Consume but never echo child diagnostics. PostgreSQL errors can include
    // values from rejected rows, so raw stderr is outside the logging boundary.
    child.stderr?.on('data', () => undefined);
    child.once('error', (error) => {
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (code === 0) return resolve();
      reject(
        new Error(
          `${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? 'unknown'}`}; PostgreSQL diagnostics were suppressed`,
        ),
      );
    });
  });
  throwIfTerminationRequested();
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
    throwIfTerminationRequested();
    if (!exists.rows[0]?.relation) continue;
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${quoteIdentifier(table)}`,
    );
    throwIfTerminationRequested();
    counts[table] = result.rows[0]?.count ?? '0';
  }
  return counts;
}

async function dropRehearsalDatabase(
  adminUrl: string,
  rehearsalDatabaseName: string,
): Promise<void> {
  const cleanupClient = new Client({ connectionString: adminUrl });
  try {
    await cleanupClient.connect();
    await cleanupClient.query(
      `DROP DATABASE ${quoteIdentifier(rehearsalDatabaseName)} WITH (FORCE)`,
    );
  } finally {
    await cleanupClient.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  terminationSignal = null;
  const removeTerminationHandlers = installTerminationHandlers();
  assertRecoveryRehearsalAllowed(process.env);
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error('DATABASE_URL is required');

  const sourceTarget = parsePostgreSqlTarget(sourceUrl);
  assertNonProductionSourceDatabase(sourceTarget.databaseName);
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
  let sourceTransactionOpen = false;
  let adminConnected = false;
  let targetCreated = false;
  let runError: unknown;

  try {
    await sourceClient.connect();
    throwIfTerminationRequested();
    await sourceClient.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    sourceTransactionOpen = true;
    const snapshotResult = await sourceClient.query<{ snapshot: string }>(
      'SELECT pg_export_snapshot() AS snapshot',
    );
    throwIfTerminationRequested();
    const snapshot = snapshotResult.rows[0]?.snapshot;
    if (!snapshot)
      throw new Error('Unable to export PostgreSQL source snapshot');

    const sourceMigrations = await readMigrationMetadata(sourceClient);
    const sourceCounts = await readCoreTableCounts(sourceClient);

    await runCommand(
      'pg_dump',
      pgDumpArgs(sourceTarget, dumpPath, snapshot),
      commandEnvironment(process.env, sourceTarget),
    );
    await assertDumpExists(dumpPath);
    await sourceClient.query('COMMIT');
    sourceTransactionOpen = false;
    throwIfTerminationRequested();

    await adminClient.connect();
    adminConnected = true;
    throwIfTerminationRequested();
    const existing = await adminClient.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [rehearsalDatabaseName],
    );
    throwIfTerminationRequested();
    if (existing.rowCount) {
      throw new Error(
        'Generated rehearsal database already exists; refusing to reuse it',
      );
    }
    await adminClient.query(
      `CREATE DATABASE ${quoteIdentifier(rehearsalDatabaseName)}`,
    );
    targetCreated = true;
    throwIfTerminationRequested();

    await runCommand(
      'pg_restore',
      pgRestoreArgs(rehearsalTarget, dumpPath),
      commandEnvironment(process.env, rehearsalTarget),
    );

    rehearsalClient = new Client({ connectionString: rehearsalUrl });
    await rehearsalClient.connect();
    throwIfTerminationRequested();
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
  } catch (error) {
    runError = error;
  } finally {
    activeChild = null;
    if (rehearsalClient) await rehearsalClient.end().catch(() => undefined);
    if (sourceTransactionOpen) {
      await sourceClient.query('ROLLBACK').catch(() => undefined);
    }
    await sourceClient.end().catch(() => undefined);
    if (adminConnected) await adminClient.end().catch(() => undefined);

    if (targetCreated) {
      try {
        await dropRehearsalDatabase(adminUrl, rehearsalDatabaseName);
      } catch {
        console.error(
          `Database recovery rehearsal cleanup failed: rehearsal database ${rehearsalDatabaseName} may require manual removal.`,
        );
        if (!runError) {
          runError = new Error(
            'Database recovery rehearsal failed because the isolated database could not be removed',
          );
        }
      }
    }

    try {
      await rm(workingDirectory, { recursive: true, force: true });
    } catch {
      console.error(
        'Database recovery rehearsal cleanup failed: temporary dump files may require manual removal.',
      );
      if (!runError) {
        runError = new Error(
          'Database recovery rehearsal failed because temporary dump files could not be removed',
        );
      }
    }
    removeTerminationHandlers();
  }

  if (runError) throw runError;
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : 'Unknown recovery rehearsal error';
  console.error(`Database recovery rehearsal failed: ${message}`);
  process.exitCode = 1;
});
