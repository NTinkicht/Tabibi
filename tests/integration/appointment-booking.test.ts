import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AppointmentConflictError,
  AppointmentService,
  AppointmentValidationError,
} from '@/modules/appointment';
import { QueueService } from '@/modules/queue';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  sessionA: randomUUID(),
  sessionClosed: randomUUID(),
  patientA: randomUUID(),
  patientA2: randomUUID(),
  patientB: randomUUID(),
};
const scope = { clinicId: ids.clinicA, actorUserId: ids.receptionist };

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE appointment_booking_receipts, appointments,
    audit_events, queue_command_receipts, queue_reorder_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'booking-reception','Reception'),
      ($2,'booking-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
      ($1,'booking-a','Clinic A'),($2,'booking-b','Clinic B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
     VALUES($1,$2,'receptionist')`,
    [ids.clinicA, ids.receptionist],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name)
     VALUES($1,$2,'Dr Booking')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id)
     VALUES($1,$3),($2,$3)`,
    [ids.clinicA, ids.clinicB, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES
      ($1,$3,$4,'2026-09-15','2026-09-15 09:00Z','2026-09-15 12:00Z','planned'),
      ($2,$3,$4,'2026-09-14','2026-09-14 09:00Z','2026-09-14 12:00Z','closed')`,
    [ids.sessionA, ids.sessionClosed, ids.clinicA, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
      (id,clinic_id,private_display_name,contact_phone,contact_email,preferred_locale)
     VALUES
      ($1,$4,'Patient A','0555000001',NULL,'fr'),
      ($2,$4,'Patient A2',NULL,'a2@example.com','ar'),
      ($3,$5,'Patient B','0555000002',NULL,'ar')`,
    [ids.patientA, ids.patientA2, ids.patientB, ids.clinicA, ids.clinicB],
  );
});
afterAll(async () => pool.end());

function bookingInput(idempotencyKey = 'book-1') {
  return {
    patientId: ids.patientA,
    scheduledStartAt: new Date('2026-09-15T09:30:00Z'),
    scheduledEndAt: new Date('2026-09-15T09:45:00Z'),
    contactPreference: 'phone' as const,
    idempotencyKey,
    correlationId: idempotencyKey,
  };
}

describe('appointment booking foundation', () => {
  it('atomically creates one confirmed appointment linked to one waiting queue entry and makes exact retry side-effect free', async () => {
    const service = new AppointmentService(pool);
    const first = await service.bookForExistingPatient(
      scope,
      ids.sessionA,
      bookingInput(),
    );
    const retry = await service.bookForExistingPatient(
      scope,
      ids.sessionA,
      bookingInput(),
    );

    expect(retry).toEqual(first);
    expect(first.appointment).toMatchObject({
      clinicId: ids.clinicA,
      doctorId: ids.doctor,
      sessionId: ids.sessionA,
      patientId: ids.patientA,
      queueEntryId: first.entry.id,
      status: 'confirmed',
      preferredLocale: 'fr',
      contactPreference: 'phone',
    });
    expect(first.entry).toMatchObject({
      sessionId: ids.sessionA,
      state: 'waiting',
      registrationOrder: 1,
    });

    const stored = await pool.query<{
      appointments: string;
      entries: string;
      source: string;
      eligibility_order: string | null;
      priority_order: string | null;
    }>(
      `SELECT
         (SELECT count(*) FROM appointments WHERE clinic_id=$1) appointments,
         (SELECT count(*) FROM queue_entries WHERE clinic_id=$1) entries,
         entry.source,
         entry.eligibility_order,
         entry.priority_order
       FROM queue_entries entry WHERE entry.id=$2`,
      [ids.clinicA, first.entry.id],
    );
    expect(stored.rows[0]).toMatchObject({
      appointments: '1',
      entries: '1',
      source: 'appointment',
      eligibility_order: null,
      priority_order: null,
    });

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
        WHERE clinic_id=$1 AND entity_type='appointment' AND entity_id=$2`,
      [ids.clinicA, first.appointment.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.metadata).toMatchObject({
      source: 'staff',
      status: 'confirmed',
      sessionId: ids.sessionA,
      queueEntryId: first.entry.id,
      registrationOrder: 1,
      contactPreference: 'phone',
    });
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain('0555000001');
  });

  it('rejects conflicting idempotency reuse, foreign patients, terminal sessions and invalid contact preferences without extra queue rows', async () => {
    const service = new AppointmentService(pool);
    await service.bookForExistingPatient(scope, ids.sessionA, bookingInput());

    await expect(
      service.bookForExistingPatient(scope, ids.sessionA, {
        ...bookingInput(),
        scheduledStartAt: new Date('2026-09-15T10:00:00Z'),
        scheduledEndAt: new Date('2026-09-15T10:15:00Z'),
      }),
    ).rejects.toBeInstanceOf(AppointmentConflictError);
    await expect(
      service.bookForExistingPatient(scope, ids.sessionClosed, {
        ...bookingInput('book-terminal'),
        scheduledStartAt: new Date('2026-09-14T09:30:00Z'),
        scheduledEndAt: new Date('2026-09-14T09:45:00Z'),
      }),
    ).rejects.toBeInstanceOf(AppointmentConflictError);
    await expect(
      service.bookForExistingPatient(scope, ids.sessionA, {
        ...bookingInput('book-foreign'),
        patientId: ids.patientB,
      }),
    ).rejects.toBeInstanceOf(AppointmentConflictError);
    await expect(
      service.bookForExistingPatient(scope, ids.sessionA, {
        ...bookingInput('book-contact'),
        patientId: ids.patientA2,
        contactPreference: 'phone',
      }),
    ).rejects.toBeInstanceOf(AppointmentValidationError);

    const counts = await pool.query<{ appointments: string; entries: string }>(
      `SELECT
         (SELECT count(*) FROM appointments WHERE clinic_id=$1) appointments,
         (SELECT count(*) FROM queue_entries WHERE clinic_id=$1) entries`,
      [ids.clinicA],
    );
    expect(counts.rows[0]).toEqual({ appointments: '1', entries: '1' });
  });

  it('serializes concurrent walk-in and appointment registration through the shared session lock', async () => {
    const queue = new QueueService(pool);
    const appointments = new AppointmentService(pool);

    const [walkIn, booking] = await Promise.all([
      queue.registerWalkIn(scope, ids.sessionA, {
        privateDisplayName: 'Concurrent walk-in',
        preferredLocale: 'ar',
        idempotencyKey: 'concurrent-walkin',
        correlationId: 'concurrent-walkin',
      }),
      appointments.bookForExistingPatient(scope, ids.sessionA, {
        patientId: ids.patientA2,
        scheduledStartAt: new Date('2026-09-15T10:30:00Z'),
        scheduledEndAt: new Date('2026-09-15T10:45:00Z'),
        contactPreference: 'email',
        idempotencyKey: 'concurrent-booking',
        correlationId: 'concurrent-booking',
      }),
    ]);

    expect(
      [walkIn.entry.registrationOrder, booking.entry.registrationOrder].sort(
        (a, b) => a - b,
      ),
    ).toEqual([1, 2]);
    const rows = await pool.query<{
      registration_order: string;
      source: string;
    }>(
      `SELECT registration_order, source FROM queue_entries
        WHERE session_id=$1 ORDER BY registration_order`,
      [ids.sessionA],
    );
    expect(rows.rows.map((row) => Number(row.registration_order))).toEqual([
      1, 2,
    ]);
    expect(new Set(rows.rows.map((row) => row.source))).toEqual(
      new Set(['walk_in', 'appointment']),
    );
  });
});
