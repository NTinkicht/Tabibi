import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
  '0008_queue_eta_timing.sql',
  '0009_appointment_booking_foundation.sql',
  '0010_appointment_booking_constraint_validation.sql',
  '0011_appointment_lifecycle.sql',
  '0012_appointment_lifecycle_terminal_commands.sql',
  '0013_appointment_recovery.sql',
  '0014_guest_exchange_credential_foundation.sql',
  '0015_guest_status_rate_limit.sql',
  '0016_notification_outbox_foundation.sql',
  '0017_notification_dispatch_claim.sql',
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

  it('exposes queue lifecycle, ETA timing, appointment-booking and notification artifacts created by later migrations', async () => {
    const artifacts = await client.query<{
      queue_order_version: string;
      reorder_receipts: string | null;
      priority_selection_idx: string | null;
      one_called_idx: string | null;
      one_consultation_idx: string | null;
      consultation_started_at: string;
      completed_at: string;
      eta_timing_idx: string | null;
      appointments: string | null;
      appointment_receipts: string | null;
      appointment_recovery_receipts: string | null;
      guest_exchange_ids: string | null;
      guest_credentials: string | null;
      guest_status_rate_limits: string | null;
      notification_outbox: string | null;
      notification_pending_idx: string | null;
      appointment_source_allowed: boolean;
      appointment_entity_allowed: boolean;
      patient_session_uq: string | null;
      temp_queue_source_constraint: string | null;
      temp_audit_constraint: string | null;
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
         to_regclass('queue_entries_one_consultation_per_session_uq')::text one_consultation_idx,
         EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_name='queue_entries' AND column_name='in_consultation_started_at'
         )::text consultation_started_at,
         EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_name='queue_entries' AND column_name='completed_at'
         )::text completed_at,
         to_regclass('queue_entries_session_completed_timing_idx')::text eta_timing_idx,
         to_regclass('appointments')::text appointments,
         to_regclass('appointment_booking_receipts')::text appointment_receipts,
         to_regclass('appointment_recovery_receipts')::text appointment_recovery_receipts,
         to_regclass('guest_exchange_ids')::text guest_exchange_ids,
         to_regclass('guest_credentials')::text guest_credentials,
         to_regclass('guest_status_rate_limit_buckets')::text guest_status_rate_limits,
         to_regclass('notification_outbox')::text notification_outbox,
         to_regclass('notification_outbox_pending_target_idx')::text notification_pending_idx,
         (SELECT pg_get_constraintdef(oid) LIKE '%appointment%'
            FROM pg_constraint
           WHERE conname='queue_entries_source_check') AS appointment_source_allowed,
         (SELECT pg_get_constraintdef(oid) LIKE '%appointment%'
            FROM pg_constraint
           WHERE conname='audit_events_entity_type_check') AS appointment_entity_allowed,
         (SELECT conname
            FROM pg_constraint
           WHERE conname='appointments_clinic_session_patient_uq') patient_session_uq,
         (SELECT conname
            FROM pg_constraint
           WHERE conname='queue_entries_source_check_wu11_tmp') temp_queue_source_constraint,
         (SELECT conname
            FROM pg_constraint
           WHERE conname='audit_events_entity_type_check_wu11_tmp') temp_audit_constraint`,
    );

    expect(artifacts.rows[0]).toEqual({
      queue_order_version: 'true',
      reorder_receipts: 'queue_reorder_receipts',
      priority_selection_idx: 'queue_entries_session_priority_selection_idx',
      one_called_idx: 'queue_entries_one_called_per_session_uq',
      one_consultation_idx: 'queue_entries_one_consultation_per_session_uq',
      consultation_started_at: 'true',
      completed_at: 'true',
      eta_timing_idx: 'queue_entries_session_completed_timing_idx',
      appointments: 'appointments',
      appointment_receipts: 'appointment_booking_receipts',
      appointment_recovery_receipts: 'appointment_recovery_receipts',
      guest_exchange_ids: 'guest_exchange_ids',
      guest_credentials: 'guest_credentials',
      guest_status_rate_limits: 'guest_status_rate_limit_buckets',
      notification_outbox: 'notification_outbox',
      notification_pending_idx: 'notification_outbox_pending_target_idx',
      appointment_source_allowed: true,
      appointment_entity_allowed: true,
      patient_session_uq: 'appointments_clinic_session_patient_uq',
      temp_queue_source_constraint: null,
      temp_audit_constraint: null,
    });
  });

  it('keeps 0010 queue lock escalation after both validation scans', async () => {
    const migration = await readFile(
      resolve(
        process.cwd(),
        'db/migrations/0010_appointment_booking_constraint_validation.sql',
      ),
      'utf8',
    );
    const queueValidate = migration.indexOf(
      'ALTER TABLE queue_entries\n  VALIDATE CONSTRAINT queue_entries_source_check_wu11_tmp;',
    );
    const auditValidate = migration.indexOf(
      'ALTER TABLE audit_events\n  VALIDATE CONSTRAINT audit_events_entity_type_check_wu11_tmp;',
    );
    const queueRename = migration.indexOf(
      'ALTER TABLE queue_entries\n  RENAME CONSTRAINT queue_entries_source_check_wu11_tmp',
    );
    const auditRename = migration.indexOf(
      'ALTER TABLE audit_events\n  RENAME CONSTRAINT audit_events_entity_type_check_wu11_tmp',
    );
    expect(queueValidate).toBeGreaterThanOrEqual(0);
    expect(auditValidate).toBeGreaterThan(queueValidate);
    expect(queueRename).toBeGreaterThan(auditValidate);
    expect(auditRename).toBeGreaterThan(queueRename);

    const writer = new Client({ connectionString: process.env.DATABASE_URL });
    const competitor = new Client({
      connectionString: process.env.DATABASE_URL,
    });
    const tryQueueWriterLock = async () => {
      await competitor.query('BEGIN');
      try {
        const result = await competitor.query(
          'LOCK TABLE queue_entries IN ROW EXCLUSIVE MODE NOWAIT',
        );
        await competitor.query('ROLLBACK');
        return result;
      } catch (error) {
        await competitor.query('ROLLBACK');
        throw error;
      }
    };
    const queueConstraint = 'queue_entries_source_check_lock_probe_tmp';
    const auditConstraint = 'audit_events_entity_type_check_lock_probe_tmp';
    await writer.connect();
    await competitor.connect();
    await client.query(
      `ALTER TABLE queue_entries
         DROP CONSTRAINT IF EXISTS ${queueConstraint}`,
    );
    await client.query(
      `ALTER TABLE queue_entries
         DROP CONSTRAINT IF EXISTS ${queueConstraint}_renamed`,
    );
    await client.query(
      `ALTER TABLE audit_events
         DROP CONSTRAINT IF EXISTS ${auditConstraint}`,
    );
    await client.query(
      `ALTER TABLE queue_entries
         ADD CONSTRAINT ${queueConstraint}
         CHECK (source IN ('walk_in', 'appointment')) NOT VALID`,
    );
    await client.query(
      `ALTER TABLE audit_events
         ADD CONSTRAINT ${auditConstraint}
         CHECK (entity_type IN (
           'clinic',
           'membership',
           'doctor',
           'schedule_template',
           'consultation_session',
           'queue_entry',
           'appointment'
         )) NOT VALID`,
    );
    let writerInTransaction = false;
    try {
      await writer.query('BEGIN');
      writerInTransaction = true;
      await writer.query(
        `ALTER TABLE queue_entries VALIDATE CONSTRAINT ${queueConstraint}`,
      );
      await writer.query(
        `ALTER TABLE audit_events VALIDATE CONSTRAINT ${auditConstraint}`,
      );
      await expect(tryQueueWriterLock()).resolves.toMatchObject({
        command: 'LOCK',
      });

      await writer.query(
        `ALTER TABLE queue_entries
           RENAME CONSTRAINT ${queueConstraint} TO ${queueConstraint}_renamed`,
      );

      await expect(tryQueueWriterLock()).rejects.toMatchObject({
        code: '55P03',
      });
      await writer.query('ROLLBACK');
      writerInTransaction = false;
    } finally {
      if (writerInTransaction) {
        await writer.query('ROLLBACK');
      }
      await client.query(
        `ALTER TABLE queue_entries
           DROP CONSTRAINT IF EXISTS ${queueConstraint}`,
      );
      await client.query(
        `ALTER TABLE queue_entries
           DROP CONSTRAINT IF EXISTS ${queueConstraint}_renamed`,
      );
      await client.query(
        `ALTER TABLE audit_events
           DROP CONSTRAINT IF EXISTS ${auditConstraint}`,
      );
      await writer.end();
      await competitor.end();
    }
  });
});
