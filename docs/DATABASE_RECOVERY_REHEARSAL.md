# Database recovery rehearsal

WU42 adds a zero-cost PostgreSQL backup/restore rehearsal for release hardening. It is deliberately an operator/development check, not a production backup scheduler.

## Safety boundary

The command refuses to run unless `TABIBI_ALLOW_DB_RECOVERY_REHEARSAL=1` is set and refuses `NODE_ENV=production`. It never restores over the source database. Instead it creates a unique temporary database on the same PostgreSQL server, restores there, validates the result, then drops that temporary database in cleanup.

The source `DATABASE_URL` is read from the environment. Passwords are removed from `pg_dump` / `pg_restore` command arguments and supplied through `PGPASSWORD`, so credentials are not echoed as command-line arguments. The command never prints database rows or patient data.

Use an administrative **non-production** PostgreSQL account that can create and drop a temporary database. Do not use production credentials for this rehearsal.

## Prerequisites

- Node.js and the repository dependencies installed with `npm ci`.
- PostgreSQL client tools `pg_dump` and `pg_restore` available on `PATH`.
- A reachable non-production PostgreSQL database whose current schema has been migrated normally.
- Permission to create and drop an isolated database on that PostgreSQL server.

## Run the rehearsal

```bash
NODE_ENV=test \
TABIBI_ALLOW_DB_RECOVERY_REHEARSAL=1 \
DATABASE_URL='postgresql://user:password@127.0.0.1:5432/tabibi_test' \
npm run db:rehearse-recovery
```

The command:

1. reads source migration metadata and bounded row counts for core operational tables;
2. creates a temporary custom-format `pg_dump` without owner/ACL metadata;
3. creates a fresh uniquely named rehearsal database;
4. restores the dump with `pg_restore --exit-on-error`;
5. verifies that `schema_migrations` names/checksums match exactly;
6. verifies bounded row counts for core tables that exist in both databases;
7. drops the rehearsal database and deletes temporary dump files on success or failure.

A successful run prints only the number of migrations and bounded tables verified. A failed run exits non-zero and reports a high-level error without printing credentials or row contents.

## CI and release usage

The PostgreSQL integration job runs the rehearsal after the normal integration suite against the ephemeral CI PostgreSQL service. This gives every proposed change a deterministic backup/restore compatibility check without any cloud backup vendor or paid service.

Before a release candidate is promoted, repeat the same command against a representative staging database. Production backup scheduling, off-host storage, retention, encryption/key management, and cross-region disaster recovery remain separate operational work and are intentionally outside WU42.
