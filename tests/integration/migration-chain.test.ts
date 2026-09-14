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
  '0018_notification_dispatch_outcomes.sql',
  '0019_notification_retry_eligibility.sql',
  '0020_notification_retry_constraint_validation.sql',
  '0021_notification_retry_claim_index.sql',
  '0022_notification_preferences.sql',
  '0023_notification_suppressed_state.sql',
  '0024_notification_suppression_constraints.sql',
  '0025_notification_inbox.sql',
  '0026_notification_inbox_read_state.sql',
  '0027_public_guest_booking.sql',
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
      notification_outbox: string | null;
      notification_preferences: string | null;
      notification_inbox_items: string | null;
      notification_inbox_read_at: string;
      public_guest_booking_receipts: string | null;
    }>(`SELECT
      (SELECT data_type FROM information_schema.columns WHERE table_name='consultation_sessions' AND column_name='queue_order_version') queue_order_version,
      to_regclass('public.queue_reorder_receipts')::text reorder_receipts,
      to_regclass('public.queue_entries_session_priority_selection_idx')::text priority_selection_idx,
      to_regclass('public.queue_entries_one_called_per_session_uq')::text one_called_idx,
      to_regclass('public.queue_entries_one_consultation_per_session_uq')::text one_consultation_idx,
      (SELECT data_type FROM information_schema.columns WHERE table_name='queue_entries' AND column_name='consultation_started_at') consultation_started_at,
      (SELECT data_type FROM information_schema.columns WHERE table_name='queue_entries' AND column_name='completed_at') completed_at,
      to_regclass('public.queue_entries_session_eta_timing_idx')::text eta_timing_idx,
      to_regclass('public.appointments')::text appointments,
      to_regclass('public.appointment_booking_receipts')::text appointment_receipts,
      to_regclass('public.appointment_recovery_receipts')::text appointment_recovery_receipts,
      to_regclass('public.guest_exchange_ids')::text guest_exchange_ids,
      to_regclass('public.guest_credentials')::text guest_credentials,
      to_regclass('public.notification_outbox')::text notification_outbox,
      to_regclass('public.notification_preferences')::text notification_preferences,
      to_regclass('public.notification_inbox_items')::text notification_inbox_items,
      (SELECT data_type FROM information_schema.columns WHERE table_name='notification_inbox_items' AND column_name='read_at') notification_inbox_read_at,
      to_regclass('public.public_guest_booking_receipts')::text public_guest_booking_receipts`);
    expect(artifacts.rows[0]).toMatchObject({
      queue_order_version: 'bigint',
      reorder_receipts: 'queue_reorder_receipts',
      priority_selection_idx: 'queue_entries_session_priority_selection_idx',
      one_called_idx: 'queue_entries_one_called_per_session_uq',
      one_consultation_idx: 'queue_entries_one_consultation_per_session_uq',
      consultation_started_at: 'timestamp with time zone',
      completed_at: 'timestamp with time zone',
      eta_timing_idx: 'queue_entries_session_eta_timing_idx',
      appointments: 'appointments',
      appointment_receipts: 'appointment_booking_receipts',
      appointment_recovery_receipts: 'appointment_recovery_receipts',
      guest_exchange_ids: 'guest_exchange_ids',
      guest_credentials: 'guest_credentials',
      notification_outbox: 'notification_outbox',
      notification_preferences: 'notification_preferences',
      notification_inbox_items: 'notification_inbox_items',
      notification_inbox_read_at: 'timestamp with time zone',
      public_guest_booking_receipts: 'public_guest_booking_receipts',
    });
  });

  it('keeps 0010 queue lock escalation after both validation scans', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'db/migrations/0010_appointment_booking_constraint_validation.sql'),
      'utf8',
    );
    const patientValidation = source.indexOf(
      'VALIDATE CONSTRAINT appointments_patient_clinic_fk',
    );
    const queueValidation = source.indexOf(
      'VALIDATE CONSTRAINT appointments_queue_entry_clinic_fk',
    );
    const lock = source.indexOf('LOCK TABLE queue_entries');
    expect(patientValidation).toBeGreaterThan(-1);
    expect(queueValidation).toBeGreaterThan(patientValidation);
    expect(lock).toBeGreaterThan(queueValidation);
  });

  it('runs the retry claim index replacement outside a migration transaction', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'db/migrations/0021_notification_retry_claim_index.sql'),
      'utf8',
    );
    expect(source).toContain('-- migrate:no-transaction');
    expect(source).toContain('CREATE INDEX CONCURRENTLY');
  });

  it('recovers safely when an interrupted concurrent retry-index build leaves the temporary index behind', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'db/migrations/0021_notification_retry_claim_index.sql'),
      'utf8',
    );
    expect(source).toContain('DROP INDEX CONCURRENTLY IF EXISTS');
  });
});
