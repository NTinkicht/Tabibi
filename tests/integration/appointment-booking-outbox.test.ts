import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AppointmentConflictError,
  AppointmentService,
} from '@/modules/appointment';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  patientA: randomUUID(),
  patientB: randomUUID(),
};
const scope = { clinicId: ids.clinicA, actorUserId: ids.receptionist };

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query('DROP FUNCTION IF EXISTS fail_outbox_insert() CASCADE');
  await pool.query(`TRUNCATE notification_outbox, appointment_booking_receipts,
    appointments, audit_events, queue_command_receipts, queue_reorder_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'abo-reception','Reception'),($2,'abo-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
      ($1,'abo-a','Clinic A'),($2,'abo-b','Clinic B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
     VALUES($1,$2,'receptionist')`,
    [ids.clinicA, ids.receptionist],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$3),($2,$3)`,
    [ids.clinicA, ids.clinicB, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES ($1,$2,$3,'2026-09-15','2026-09-15 09:00Z','2026-09-15 12:00Z','open')`,
    [ids.session, ids.clinicA, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
      (id,clinic_id,private_display_name,contact_phone,contact_email,preferred_locale)
     VALUES ($1,$3,'Secret Patient A','0555000001',NULL,'fr'),
            ($2,$4,'Patient B','0555000002',NULL,'ar')`,
    [ids.patientA, ids.patientB, ids.clinicA, ids.clinicB],
  );
});
afterAll(() => pool.end());

const input = (key: string, patientId = ids.patientA) => ({
  patientId,
  scheduledStartAt: new Date('2026-09-15T09:30:00Z'),
  scheduledEndAt: new Date('2026-09-15T09:45:00Z'),
  contactPreference: 'phone' as const,
  idempotencyKey: key,
  correlationId: key,
});
const book = (key: string, patientId = ids.patientA) =>
  new AppointmentService(pool).bookForExistingPatient(
    scope,
    ids.session,
    input(key, patientId),
  );
const count = async (table: string) =>
  Number(
    (await pool.query<{ n: string }>(`SELECT count(*)::text n FROM ${table}`))
      .rows[0]!.n,
  );

describe('appointment booking outbox atomicity', () => {
  it('writes exactly one pending appointment_confirmed intent with a locale-only payload', async () => {
    const booking = await book('abo-1');
    const rows = (
      await pool.query<{
        clinic_id: string;
        queue_entry_id: string;
        logical_target_key: string;
        event_key: string;
        state: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT clinic_id,queue_entry_id,logical_target_key,event_key,state,payload
           FROM notification_outbox`,
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clinic_id: ids.clinicA,
      queue_entry_id: booking.entry.id,
      logical_target_key: `queue-entry:${booking.entry.id}`,
      event_key: 'appointment_confirmed',
      state: 'pending',
      payload: { locale: 'fr' },
    });
    expect(Object.keys(rows[0]!.payload)).toEqual(['locale']);
    expect(JSON.stringify(rows[0])).not.toContain('Secret Patient A');
    expect(JSON.stringify(rows[0])).not.toContain('0555000001');
  });

  it('keeps a single intent on exact retry', async () => {
    const first = await book('abo-retry');
    const retry = await book('abo-retry');
    expect(retry).toEqual(first);
    expect(await count('notification_outbox')).toBe(1);
  });

  it('rolls the whole booking back when the outbox write fails, and commits without the failure', async () => {
    await pool.query(`CREATE FUNCTION fail_outbox_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox down'; END $$`);
    await pool.query(`CREATE TRIGGER fail_outbox_insert BEFORE INSERT
      ON notification_outbox FOR EACH ROW EXECUTE FUNCTION fail_outbox_insert()`);
    try {
      await expect(book('abo-fail')).rejects.toThrow('outbox down');
    } finally {
      await pool.query('DROP FUNCTION fail_outbox_insert() CASCADE');
    }
    for (const table of [
      'appointments',
      'queue_entries',
      'appointment_booking_receipts',
      'notification_outbox',
    ])
      expect(await count(table)).toBe(0);
    const audit = await pool.query(
      `SELECT 1 FROM audit_events WHERE action='appointment_booked'`,
    );
    expect(audit.rowCount).toBe(0);

    // Positive control: the same request commits once the outbox is healthy.
    await book('abo-fail');
    expect(await count('appointments')).toBe(1);
    expect(await count('notification_outbox')).toBe(1);
  });

  it('creates no intent for a foreign-clinic patient (refused for the tenant reason)', async () => {
    await expect(book('abo-foreign', ids.patientB)).rejects.toThrow(
      AppointmentConflictError,
    );
    await expect(book('abo-foreign', ids.patientB)).rejects.toThrow(
      'Patient was not found in this clinic',
    );
    expect(await count('notification_outbox')).toBe(0);
    expect(await count('appointments')).toBe(0);
  });
});
