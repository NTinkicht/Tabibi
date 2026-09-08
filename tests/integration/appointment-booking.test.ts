import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as appointmentRoute } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/appointments/route';
import {
  AppointmentConflictError,
  AppointmentService,
  AppointmentValidationError,
} from '@/modules/appointment';
import { QueueService } from '@/modules/queue';
import { migrate } from '../../scripts/db/lib';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  receptionist: randomUUID(),
  otherReceptionist: randomUUID(),
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
  process.env.STAFF_SESSION_SECRET =
    'appointment-booking-test-secret-at-least-32-characters';
  await pool.query(`TRUNCATE appointment_booking_receipts, appointments,
    audit_events, queue_command_receipts, queue_reorder_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'booking-reception','Reception'),
      ($2,'booking-reception-b','Reception B'),
      ($3,'booking-doctor','Doctor')`,
    [ids.receptionist, ids.otherReceptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
      ($1,'booking-a','Clinic A'),($2,'booking-b','Clinic B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
     VALUES($1,$2,'receptionist'),
           ($3,$4,'receptionist')`,
    [ids.clinicA, ids.receptionist, ids.clinicB, ids.otherReceptionist],
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
      ($1,$3,$4,'2026-09-15','2026-09-15 09:00Z','2026-09-15 12:00Z','open'),
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
afterAll(async () => {
  await closePool();
  await pool.end();
});

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

function authCookie(authSubject: string) {
  return `tabibi_staff_session=${createStaffSessionToken(
    authSubject,
    new Date(Date.now() + 60_000),
  )}`;
}

describe('appointment booking foundation', () => {
  it('atomically creates one confirmed appointment linked to one waiting queue entry and preserves exact retry after check-in', async () => {
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

    await new QueueService(pool).command(scope, ids.sessionA, first.entry.id, {
      command: 'check_in',
      idempotencyKey: 'check-in-booked',
      correlationId: 'check-in-booked',
    });
    const retryAfterCheckIn = await service.bookForExistingPatient(
      scope,
      ids.sessionA,
      bookingInput(),
    );
    expect(retryAfterCheckIn.appointment.status).toBe('checked_in');
    expect(retryAfterCheckIn.entry.state).toBe('checked_in');
    const auditCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text count FROM audit_events
        WHERE clinic_id=$1 AND entity_type='appointment' AND entity_id=$2`,
      [ids.clinicA, first.appointment.id],
    );
    expect(auditCount.rows[0]!.count).toBe('1');
  });

  it('synchronizes whole-session cancellation into the linked appointment', async () => {
    const service = new AppointmentService(pool);
    const booking = await service.bookForExistingPatient(
      scope,
      ids.sessionA,
      bookingInput('book-session-cancel'),
    );

    await pool.query(
      `UPDATE consultation_sessions SET status='cancelled',updated_at=now()
        WHERE id=$1 AND clinic_id=$2`,
      [ids.sessionA, ids.clinicA],
    );
    const states = await pool.query<{ appointment: string; entry: string }>(
      `SELECT appointment.status::text appointment, entry.state::text entry
         FROM appointments appointment
         JOIN queue_entries entry ON entry.id=appointment.queue_entry_id
        WHERE appointment.id=$1`,
      [booking.appointment.id],
    );
    expect(states.rows[0]).toEqual({
      appointment: 'cancelled',
      entry: 'cancelled',
    });
  });

  it('rejects a second patient booking for the same session under a different idempotency key without committing another pair', async () => {
    const service = new AppointmentService(pool);
    const first = await service.bookForExistingPatient(
      scope,
      ids.sessionA,
      bookingInput('book-dup-1'),
    );

    await expect(
      service.bookForExistingPatient(
        scope,
        ids.sessionA,
        bookingInput('book-dup-2'),
      ),
    ).rejects.toBeInstanceOf(AppointmentConflictError);

    const counts = await pool.query<{
      appointments: string;
      entries: string;
      appointment_id: string;
      queue_entry_id: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM appointments WHERE clinic_id=$1) appointments,
         (SELECT count(*)::text FROM queue_entries WHERE clinic_id=$1) entries,
         (SELECT id FROM appointments WHERE clinic_id=$1) appointment_id,
         (SELECT id FROM queue_entries WHERE clinic_id=$1) queue_entry_id`,
      [ids.clinicA],
    );
    expect(counts.rows[0]).toEqual({
      appointments: '1',
      entries: '1',
      appointment_id: first.appointment.id,
      queue_entry_id: first.entry.id,
    });
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

  it('rejects an authenticated actor without target-clinic membership before side effects', async () => {
    const response = await appointmentRoute(
      new Request(
        `http://localhost/api/clinics/${ids.clinicA}/sessions/${ids.sessionA}/appointments`,
        {
          method: 'POST',
          headers: {
            origin: 'http://localhost',
            'content-type': 'application/json',
            'idempotency-key': 'book-forbidden',
            cookie: authCookie('booking-reception-b'),
          },
          body: JSON.stringify({
            patientId: ids.patientA,
            scheduledStartAt: '2026-09-15T09:30:00Z',
            scheduledEndAt: '2026-09-15T09:45:00Z',
            contactPreference: 'phone',
          }),
        },
      ),
      {
        params: Promise.resolve({
          clinicId: ids.clinicA,
          sessionId: ids.sessionA,
        }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'forbidden',
    });

    const counts = await pool.query<{
      appointments: string;
      entries: string;
      audits: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM appointments WHERE clinic_id=$1) appointments,
         (SELECT count(*)::text FROM queue_entries WHERE clinic_id=$1) entries,
         (SELECT count(*)::text FROM audit_events WHERE clinic_id=$1 AND entity_type='appointment') audits`,
      [ids.clinicA],
    );
    expect(counts.rows[0]).toEqual({
      appointments: '0',
      entries: '0',
      audits: '0',
    });
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
