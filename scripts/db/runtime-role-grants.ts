import type { PoolClient } from 'pg';
import { getEnvironment } from '../../src/platform/config/env';

/**
 * Explicit current-schema application DML surface.
 *
 * Intentionally excludes schema_migrations and all new/unrecognized tables:
 * changing the database schema requires a reviewed manifest update rather
 * than silently giving the runtime account new table privileges.
 */
const applicationTables = [
  'platform_metadata',
  'users',
  'clinics',
  'clinic_memberships',
  'doctor_profiles',
  'doctor_clinics',
  'schedule_templates',
  'consultation_sessions',
  'audit_events',
  'session_command_receipts',
  'patient_operational_records',
  'queue_entries',
  'queue_registration_receipts',
  'queue_command_receipts',
  'queue_reorder_receipts',
  'appointments',
  'appointment_booking_receipts',
  'appointment_lifecycle_receipts',
  'appointment_recovery_receipts',
  'guest_exchange_ids',
  'guest_credentials',
  'guest_status_rate_limit_buckets',
  'notification_outbox',
  'notification_preferences',
  'notification_preference_receipts',
  'notification_inbox_items',
  'public_guest_booking_receipts',
  'public_guest_check_in_operations',
  'patient_dependents',
  'appointment_bulk_no_show_receipts',
  'eta_clinic_prior_epochs',
  'eta_session_source_epochs',
  'doctor_active_consultations',
  'eta_uncertainty_claims',
  'eta_claim_idempotency_receipts',
] as const;

const immutableTables = new Set<string>([
  'audit_events',
  'session_command_receipts',
  'queue_registration_receipts',
  'queue_command_receipts',
  'queue_reorder_receipts',
  'appointment_booking_receipts',
  'appointment_lifecycle_receipts',
  'appointment_recovery_receipts',
  'notification_preference_receipts',
  'public_guest_booking_receipts',
  'public_guest_check_in_operations',
  'appointment_bulk_no_show_receipts',
  'eta_uncertainty_claims',
  'eta_claim_idempotency_receipts',
]);

function identifier(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

export async function provisionRuntimeDmlGrants(
  client: Pick<PoolClient, 'query'>,
  source: Record<string, string | undefined> = process.env,
): Promise<void> {
  const env = getEnvironment(source);
  if (env.NODE_ENV !== 'production') return;
  const username = decodeURIComponent(new URL(env.DATABASE_URL).username);
  if (!username) {
    throw new Error('Production runtime database login is missing');
  }

  // The application login must exist independently before provisioning.
  // Never create a role, copy its password, or grant schema ownership.
  const result = await client.query<{
    oid: string;
    safe_login: boolean;
    owner_membership: boolean;
    any_membership: boolean;
    owns_public_object: boolean;
    can_create_schema_objects: boolean;
  }>(
    `SELECT r.oid::text,
            (r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole
             AND NOT r.rolcreatedb AND NOT r.rolreplication
             AND NOT r.rolbypassrls) AS safe_login,
            pg_has_role(r.oid, current_user::regrole::oid, 'MEMBER')
              AS owner_membership,
            EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
              AS any_membership,
            (EXISTS(SELECT 1 FROM pg_class c
                     JOIN pg_namespace n ON n.oid=c.relnamespace
                     WHERE n.nspname='public' AND c.relowner=r.oid)
              OR EXISTS(SELECT 1 FROM pg_proc p
                     JOIN pg_namespace n ON n.oid=p.pronamespace
                     WHERE n.nspname='public' AND p.proowner=r.oid))
              AS owns_public_object,
            has_schema_privilege(r.oid,'public','CREATE')
              AS can_create_schema_objects
       FROM pg_roles r WHERE r.rolname=$1`,
    [username],
  );
  if (
    result.rows.length !== 1 ||
    !result.rows[0]?.safe_login ||
    result.rows[0].owner_membership ||
    result.rows[0].any_membership ||
    result.rows[0].owns_public_object ||
    result.rows[0].can_create_schema_objects
  ) {
    throw new Error(
      'Production runtime login missing or carries schema/owner privileges',
    );
  }

  const objects = await client.query<{
    tablename: string;
    owned_by_migrator: boolean;
  }>(
    `SELECT tablename, tableowner=current_user AS owned_by_migrator
       FROM pg_tables
      WHERE schemaname='public' AND tablename<>'schema_migrations'`,
  );
  const observed = new Set(objects.rows.map((r) => r.tablename));
  // Unknown owner-only tables remain deny-by-default: do not grant them.
  // Missing required tables are fatal because app operations would fail or
  // an incomplete migration might otherwise appear to be provisioned.
  const missing = applicationTables.filter((table) => !observed.has(table));
  if (missing.length > 0) {
    throw new Error(
      `Runtime grants manifest missing required tables: ${missing.join(',')}`,
    );
  }
  if (
    objects.rows.some(
      (row) =>
        applicationTables.includes(
          row.tablename as (typeof applicationTables)[number],
        ) && !row.owned_by_migrator,
    )
  ) {
    throw new Error('Runtime grant target is not owned by the migrator');
  }

  const role = identifier(username);
  await client.query('BEGIN');
  try {
    // Reconciliation, not additive grants. Prior manual grants or older
    // manifest versions must never survive a reviewed privilege reduction.
    // Unknown tables are explicitly denied by default, including migration
    // metadata. Never revoke privileges from the owner or PUBLIC.
    // A migrator must not attempt REVOKE on unrelated owner/extension
    // objects it cannot administer. Those objects are validated below and
    // any effective access is refused, not silently accepted.
    const ownedTables = await client.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
        WHERE ns.nspname='public' AND c.relkind IN ('r','p','v','m','f')
          AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)`,
    );
    for (const owned of ownedTables.rows) {
      await client.query(
        `REVOKE ALL PRIVILEGES ON TABLE public.${identifier(owned.name)} FROM ${role}`,
      );
    }
    const ownedSequences = await client.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
        WHERE ns.nspname='public' AND c.relkind='S'
          AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)`,
    );
    for (const owned of ownedSequences.rows) {
      await client.query(
        `REVOKE ALL PRIVILEGES ON SEQUENCE public.${identifier(owned.name)} FROM ${role}`,
      );
    }
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    for (const table of applicationTables) {
      let permissions = 'SELECT, INSERT, UPDATE, DELETE';
      if (table === 'platform_metadata') {
        permissions = 'SELECT';
      } else if (table === 'doctor_active_consultations') {
        permissions = 'SELECT';
      } else if (immutableTables.has(table)) {
        permissions = 'SELECT, INSERT';
      }
      await client.query(
        `GRANT ${permissions} ON TABLE public.${identifier(table)} TO ${role}`,
      );
    }
    // Only sequences owned by current known application tables, not
    // unrelated owner-only schema state, may be used by the runtime.
    const sequences = await client.query<{ sequence_name: string }>(
      `SELECT seq.relname AS sequence_name
         FROM pg_class seq
         JOIN pg_namespace sn ON sn.oid=seq.relnamespace
         JOIN pg_depend dep ON dep.objid=seq.oid
            AND dep.deptype IN ('a','i')
         JOIN pg_class parent ON parent.oid=dep.refobjid
         JOIN pg_namespace pn ON pn.oid=parent.relnamespace
        WHERE seq.relkind='S'
          AND sn.nspname='public' AND pn.nspname='public'
          AND parent.relname=ANY($1::text[])`,
      [applicationTables],
    );
    for (const seq of sequences.rows) {
      await client.query(
        `GRANT USAGE, SELECT ON SEQUENCE public.${identifier(seq.sequence_name)} TO ${role}`,
      );
    }
    // Effective access is direct + inherited + PUBLIC. A successful
    // GRANT/REVOKE command alone does not attest least privilege.
    const tableRights = await client.query<{
      tablename: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      can_truncate: boolean;
      can_references: boolean;
      can_trigger: boolean;
    }>(
      `SELECT c.relname AS tablename,
        has_table_privilege($1::oid,c.oid,'SELECT') AS can_select,
        has_table_privilege($1::oid,c.oid,'INSERT') AS can_insert,
        has_table_privilege($1::oid,c.oid,'UPDATE') AS can_update,
        has_table_privilege($1::oid,c.oid,'DELETE') AS can_delete,
        has_table_privilege($1::oid,c.oid,'TRUNCATE') AS can_truncate,
        has_table_privilege($1::oid,c.oid,'REFERENCES') AS can_references,
        has_table_privilege($1::oid,c.oid,'TRIGGER') AS can_trigger
       FROM pg_class c
       JOIN pg_namespace ns ON ns.oid=c.relnamespace
      WHERE ns.nspname='public' AND c.relkind IN ('r','p','v','m','f')`,
      [result.rows[0]!.oid],
    );
    for (const actual of tableRights.rows) {
      const table = actual.tablename;
      const listed = (applicationTables as readonly string[]).includes(table);
      const readable = listed;
      const insertable =
        listed &&
        table !== 'platform_metadata' &&
        table !== 'doctor_active_consultations';
      const writable =
        listed &&
        table !== 'platform_metadata' &&
        !immutableTables.has(table) &&
        table !== 'doctor_active_consultations';
      const deletable = writable;
      if (
        actual.can_select !== readable ||
        actual.can_insert !== insertable ||
        actual.can_update !== writable ||
        actual.can_delete !== deletable ||
        actual.can_truncate ||
        actual.can_references ||
        actual.can_trigger
      ) {
        throw new Error(
          `Unexpected effective runtime table privilege: ${table}`,
        );
      }
    }
    const sequenceRights = await client.query<{
      sequencename: string;
      can_usage: boolean;
      can_select: boolean;
      can_update: boolean;
    }>(
      `SELECT c.relname AS sequencename,
        has_sequence_privilege($1::oid,c.oid,'USAGE') AS can_usage,
        has_sequence_privilege($1::oid,c.oid,'SELECT') AS can_select,
        has_sequence_privilege($1::oid,c.oid,'UPDATE') AS can_update
       FROM pg_class c
       JOIN pg_namespace ns ON ns.oid=c.relnamespace
      WHERE ns.nspname='public' AND c.relkind='S'`,
      [result.rows[0]!.oid],
    );
    const expectedSequences = new Set(
      sequences.rows.map((seq) => seq.sequence_name),
    );
    for (const actual of sequenceRights.rows) {
      const expected = expectedSequences.has(actual.sequencename);
      if (
        actual.can_usage !== expected ||
        actual.can_select !== expected ||
        actual.can_update
      ) {
        throw new Error(
          `Unexpected effective runtime sequence privilege: ${actual.sequencename}`,
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
