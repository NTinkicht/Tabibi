import type { PoolClient } from 'pg';

/** Fail-closed check against privileged owner connections in production.
 * The check runs on the exact connection used to publish an ETA claim.
 */
export async function assertEtaClaimRuntimeRole(
  client: Pick<PoolClient, 'query'>,
  environment: string | undefined = process.env.NODE_ENV,
): Promise<void> {
  if (environment !== 'production') return;
  // A runtime that can read the migrator credential can switch connection
  // roles even if its current PostgreSQL session is least privileged.
  if (process.env.MIGRATION_DATABASE_URL) {
    throw new Error('Privileged migration credential must not reach runtime');
  }
  const check = await client.query<{ least_privileged: boolean }>(
    `SELECT (
        NOT current_role_info.rolsuper
        AND NOT current_role_info.rolcreaterole
        AND NOT current_role_info.rolbypassrls
        AND NOT pg_has_role(
          current_user::regrole::oid, claim_table.relowner, 'MEMBER'
        )
        AND NOT pg_has_role(
          current_user::regrole::oid, guard_func.proowner, 'MEMBER'
        )
        AND publication_trigger.tgenabled = 'O'
        AND publication_trigger.tgfoid = guard_func.oid
      ) AS least_privileged
       FROM pg_class claim_table
       JOIN pg_namespace claim_schema
         ON claim_schema.oid=claim_table.relnamespace
       JOIN pg_trigger publication_trigger
         ON publication_trigger.tgrelid=claim_table.oid
        AND publication_trigger.tgname='eta_guard_claim_publication_insert'
        AND NOT publication_trigger.tgisinternal
       JOIN pg_proc guard_func
         ON guard_func.oid=publication_trigger.tgfoid
        AND guard_func.proname='eta_guard_claim_publication'
        AND guard_func.pronargs=0
       JOIN pg_roles current_role_info
         ON current_role_info.rolname=current_user
      WHERE claim_schema.nspname='public'
        AND claim_table.relname='eta_uncertainty_claims'`,
  );
  if (check.rows.length !== 1 || check.rows[0]?.least_privileged !== true) {
    throw new Error(
      'ETA claim runtime database role is privileged or guard is unavailable',
    );
  }
}
