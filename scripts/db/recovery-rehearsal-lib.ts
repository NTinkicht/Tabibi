import { access } from 'node:fs/promises';

export const recoveryRehearsalCoreTables = [
  'clinics',
  'users',
  'consultation_sessions',
  'queue_entries',
  'notification_outbox',
  'notification_inbox_items',
] as const;

export interface PostgreSqlCommandTarget {
  safeDsn: string;
  password?: string;
  databaseName: string;
}

export interface RecoveryRehearsalEnvironment {
  TABIBI_ALLOW_DB_RECOVERY_REHEARSAL?: string;
  NODE_ENV?: string;
}

export function parsePostgreSqlTarget(raw: string): PostgreSqlCommandTarget {
  const url = new URL(raw);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!databaseName)
    throw new Error('DATABASE_URL must include a database name');

  const password = url.password ? decodeURIComponent(url.password) : undefined;
  url.password = '';

  return {
    safeDsn: url.toString(),
    password,
    databaseName,
  };
}

export function assertRecoveryRehearsalAllowed(
  env: RecoveryRehearsalEnvironment,
): void {
  if (env.TABIBI_ALLOW_DB_RECOVERY_REHEARSAL !== '1') {
    throw new Error(
      'Recovery rehearsal is disabled; set TABIBI_ALLOW_DB_RECOVERY_REHEARSAL=1 explicitly',
    );
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('Recovery rehearsal refuses to run with NODE_ENV=production');
  }
}

export function assertNonProductionSourceDatabase(databaseName: string): void {
  if (!/(^|[_-])(test|dev|stage|staging|local|sandbox)([_-]|$)/i.test(databaseName)) {
    throw new Error(
      'Recovery rehearsal source database name must explicitly identify a non-production environment',
    );
  }
}

export function buildRehearsalDatabaseName(
  sourceDatabaseName: string,
  suffix: string,
): string {
  const normalizedSource = sourceDatabaseName
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
  const normalizedSuffix = suffix.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16);
  if (!normalizedSource || !normalizedSuffix) {
    throw new Error('Unable to derive a safe rehearsal database name');
  }
  const name = `${normalizedSource}_rehearsal_${normalizedSuffix}`;
  if (name === sourceDatabaseName) {
    throw new Error('Rehearsal database must differ from the source database');
  }
  return name.slice(0, 63);
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function databaseUrlForDatabase(
  raw: string,
  databaseName: string,
): string {
  const url = new URL(raw);
  url.pathname = `/${encodeURIComponent(databaseName)}`;
  return url.toString();
}

export function commandEnvironment(
  base: NodeJS.ProcessEnv,
  target: PostgreSqlCommandTarget,
): NodeJS.ProcessEnv {
  return target.password
    ? { ...base, PGPASSWORD: target.password }
    : { ...base };
}

export function pgDumpArgs(
  target: PostgreSqlCommandTarget,
  dumpPath: string,
): string[] {
  return [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    '--file',
    dumpPath,
    '--dbname',
    target.safeDsn,
  ];
}

export function pgRestoreArgs(
  target: PostgreSqlCommandTarget,
  dumpPath: string,
): string[] {
  return [
    '--exit-on-error',
    '--no-owner',
    '--no-acl',
    '--dbname',
    target.safeDsn,
    dumpPath,
  ];
}

export async function assertDumpExists(path: string): Promise<void> {
  await access(path);
}

export function migrationMetadataMatches(
  source: ReadonlyArray<{ name: string; checksum: string }>,
  restored: ReadonlyArray<{ name: string; checksum: string }>,
): boolean {
  return JSON.stringify(source) === JSON.stringify(restored);
}

export function rowCountsMatch(
  source: Readonly<Record<string, string>>,
  restored: Readonly<Record<string, string>>,
): boolean {
  return JSON.stringify(source) === JSON.stringify(restored);
}
