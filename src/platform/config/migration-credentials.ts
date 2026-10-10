import { getEnvironment } from './env';

/** Migrations and serving must never share the owner credential in production.
 * The migration variable is delivered only to isolated deployment/migrate
 * jobs, never the application runtime environment.
 */
export function migrationConnectionString(
  source: Record<string, string | undefined> = process.env,
): string {
  const env = getEnvironment(source);
  const privileged = source.MIGRATION_DATABASE_URL;
  if (env.NODE_ENV !== 'production') {
    return privileged || env.DATABASE_URL;
  }
  if (!privileged) {
    throw new Error(
      'Production migrations require a separate MIGRATION_DATABASE_URL',
    );
  }
  let owner: URL;
  try {
    owner = new URL(privileged);
  } catch {
    throw new Error('Invalid production migration connection URL');
  }
  const runtime = new URL(env.DATABASE_URL);
  if (
    owner.protocol !== 'postgresql:' ||
    !owner.username ||
    !owner.pathname ||
    decodeURIComponent(owner.username) === decodeURIComponent(runtime.username)
  ) {
    throw new Error(
      'Production migrator and runtime must use distinct PostgreSQL roles',
    );
  }
  return privileged;
}
