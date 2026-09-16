import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as appointmentRoute } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/appointments/route';
import { AppointmentConflictError, AppointmentService } from '@/modules/appointment';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinic: randomUUID(),
  owner: randomUUID(),
  otherOwner: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  patient: randomUUID(),
  activeDependent: randomUUID(),
  crossAccountDependent: randomUUID(),
  archivedDependent: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.owner };

beforeAll(async () => migrate());

beforeEach(async () => {
  process.env.STAFF_SESSION_SECRET =
    'wu70-dependent-booking-test-secret-at-least-32-characters';
  await pool.query(`TRUNCATE appointment_booking_receipts, appointments,
    audit_events, queue_entries, patient_dependents, patient_operational_records,
    consultation_sessions, schedule_templates, doctor_clinics, doctor_profiles,
    clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'wu70-owner','Owner'),
      ($2,'wu70-other-owner','Other Owner'),
      ($3,'wu70-doctor','Doctor')`,
    [ids.owner, ids.otherOwner, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name)
     VALUES($1,'wu70-clinic','WU70 Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
     VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.owner],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name)
     VALUES($1,$2,'Dr WU70')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,'2026-09-16','2026-09-16 09:00Z','2026-09-16 12:00Z','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
      (id,clinic_id,account_user_id,private_display_name,contact_phone,preferred_locale)
     VALUES($1,$2,$3,'Owner Patient','0555007001','fr')`,
    [ids.patient, ids.clinic, ids.owner],
  );
  await pool.query(
    `INSERT INTO patient_dependents
      (id,owner_user_id,display_name,status,archived_at)
     VALUES
      ($1,$4,'ليان Élodie','active',NULL),
      ($2,$5,'Other Child','active',NULL),
      ($3,$4,'Enfant archivé','archived',now())`,
    [
      ids.activeDependent,
      ids.crossAccountDependent,
      ids.archivedDependent,
      ids.owner,
      ids.otherOwner,
    ],
  );
});

afterAll(async () => {
  await closePool();
  await pool.end();
});

function bookingInput(
  idempotencyKey: string,
  dependentId: string | null = ids.activeDependent,
) {
  return {
    patientId: ids.patient,
    dependentId,
    scheduledStartAt: new Date('2026-09-16T09:30:00Z'),
    scheduledEndAt: new Date('2026-09-16T09:45:00Z'),
    contactPreference: 'phone' as const,
    idempotencyKey,
    correlationId: idempotencyKey,
  };
}

function authCookie() {
  return `tabibi_staff_session=${createStaffSessionToken(
    'wu70-owner',
    new Date(Date.now() + 60_000),
  )}`;
}

async function routeBooking(dependentId: string, idempotencyKey: string) {
  return appointmentRoute(
    new Request(
      `http://localhost/api/clinics/${ids.clinic}/sessions/${ids.session}/appointments`,
      {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
          cookie: authCookie(),
        },
        body: JSON.stringify({
          patientId: ids.patient,
          dependentId,
          scheduledStartAt: '2026-09-16T09:30:00Z',
          scheduledEndAt: '2026-09-16T09:45:00Z',
          contactPreference: 'phone',
        }),
      },
    ),
    {
      params: Promise.resolve({
        clinicId: ids.clinic,
        sessionId: ids.session,
      }),
    },
  );
}

async function bookingSinkCounts() {
  const result = await pool.query<{
    entries: string;
    appointments: string;
    receipts: string;
    audits: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM queue_entries WHERE clinic_id=$1) entries,
       (SELECT count(*)::text FROM appointments WHERE clinic_id=$1) appointments,
       (SELECT count(*)::text FROM appointment_booking_receipts WHERE clinic_id=$1) receipts,
       (SELECT count(*)::text FROM audit_events
         WHERE clinic_id=$1 AND entity_type='appointment') audits`,
    [ids.clinic],
  );
  return result.rows[0]!;
}

describe('WU70 dependent booking authorization boundary', () => {
  it('books one active owned dependent and persists only an internal durable reference', async () => {
    const booking = await new AppointmentService(pool).bookForExistingPatient(
      scope,
      ids.session,
      bookingInput('wu70-owned'),
    );

    const stored = await pool.query<{ dependent_id: string | null }>(
      `SELECT dependent_id FROM appointments WHERE id=$1 AND clinic_id=$2`,
      [booking.appointment.id, ids.clinic],
    );
    expect(stored.rows[0]?.dependent_id).toBe(ids.activeDependent);
    expect(JSON.stringify(booking)).not.toContain(ids.activeDependent);
    expect(JSON.stringify(booking)).not.toContain('ليان');
    expect(JSON.stringify(booking)).not.toContain('Élodie');

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
        WHERE clinic_id=$1 AND entity_type='appointment' AND entity_id=$2`,
      [ids.clinic, booking.appointment.id],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ subjectKind: 'dependent' });
    const serializedAudit = JSON.stringify(audit.rows[0]?.metadata);
    expect(serializedAudit).not.toContain(ids.activeDependent);
    expect(serializedAudit).not.toContain('ليان');
    expect(serializedAudit).not.toContain('Élodie');
  });

  it('fails malformed, unknown, cross-account and archived dependent references identically with zero writes', async () => {
    const dependentIds = [
      'not-a-uuid',
      randomUUID(),
      ids.crossAccountDependent,
      ids.archivedDependent,
    ];
    const failures: Array<{ status: number; error: unknown; message: unknown }> = [];

    for (const [index, dependentId] of dependentIds.entries()) {
      const response = await routeBooking(dependentId, `wu70-deny-${index}`);
      const body = (await response.json()) as {
        error?: unknown;
        message?: unknown;
      };
      failures.push({
        status: response.status,
        error: body.error,
        message: body.message,
      });
    }

    expect(failures).toEqual(
      dependentIds.map(() => ({
        status: 409,
        error: 'conflict',
        message: 'Dependent is unavailable for booking',
      })),
    );
    expect(await bookingSinkCounts()).toEqual({
      entries: '0',
      appointments: '0',
      receipts: '0',
      audits: '0',
    });
  });

  it('fails closed when archive wins the row race before dependent authorization', async () => {
    const archiver = await pool.connect();
    try {
      await archiver.query('BEGIN');
      await archiver.query(
        `UPDATE patient_dependents
            SET status='archived', archived_at=now(), updated_at=now()
          WHERE id=$1 AND owner_user_id=$2`,
        [ids.activeDependent, ids.owner],
      );

      const bookingPromise = new AppointmentService(pool).bookForExistingPatient(
        scope,
        ids.session,
        bookingInput('wu70-archive-race'),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      await archiver.query('COMMIT');

      await expect(bookingPromise).rejects.toBeInstanceOf(
        AppointmentConflictError,
      );
      expect(await bookingSinkCounts()).toEqual({
        entries: '0',
        appointments: '0',
        receipts: '0',
        audits: '0',
      });
    } finally {
      await archiver.query('ROLLBACK').catch(() => undefined);
      archiver.release();
    }
  });

  it('preserves idempotent at-most-one booking under concurrent retries', async () => {
    const service = new AppointmentService(pool);
    const input = bookingInput('wu70-concurrent-retry');
    const [first, second] = await Promise.all([
      service.bookForExistingPatient(scope, ids.session, input),
      service.bookForExistingPatient(scope, ids.session, input),
    ]);

    expect(second).toEqual(first);
    expect(await bookingSinkCounts()).toEqual({
      entries: '1',
      appointments: '1',
      receipts: '1',
      audits: '1',
    });
  });

  it('keeps existing self-booking behavior backward compatible', async () => {
    const booking = await new AppointmentService(pool).bookForExistingPatient(
      scope,
      ids.session,
      bookingInput('wu70-self', null),
    );

    const stored = await pool.query<{ dependent_id: string | null }>(
      `SELECT dependent_id FROM appointments WHERE id=$1`,
      [booking.appointment.id],
    );
    expect(stored.rows[0]?.dependent_id).toBeNull();
    expect(booking.appointment.patientId).toBe(ids.patient);
    expect(await bookingSinkCounts()).toEqual({
      entries: '1',
      appointments: '1',
      receipts: '1',
      audits: '1',
    });
  });
});
