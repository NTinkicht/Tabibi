import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { PublicDoctorAvailabilityService } from '@/modules/public-availability';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

beforeAll(async () => migrate());

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_reorder_receipts, queue_command_receipts,
    queue_registration_receipts, queue_entries, appointments,
    appointment_booking_receipts, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
});

afterAll(async () => pool.end());

async function mutationCounts() {
  const result = await pool.query<{
    sessions: string;
    appointments: string;
    queue_entries: string;
    audits: string;
  }>(`SELECT
      (SELECT count(*)::text FROM consultation_sessions) sessions,
      (SELECT count(*)::text FROM appointments) appointments,
      (SELECT count(*)::text FROM queue_entries) queue_entries,
      (SELECT count(*)::text FROM audit_events) audits`);
  return result.rows[0];
}

describe('public doctor availability', () => {
  it('returns deterministic future bookable session windows without leaking internal identity or mutating state', async () => {
    const clinicA = randomUUID();
    const clinicB = randomUUID();
    const inactiveClinic = randomUUID();
    const doctorA = randomUUID();
    const doctorB = randomUUID();
    const hiddenDoctor = randomUUID();
    const doctorAUser = randomUUID();
    const doctorBUser = randomUUID();
    const hiddenDoctorUser = randomUUID();
    const sessionLater = randomUUID();
    const sessionEarlier = randomUUID();
    const terminalSession = randomUUID();
    const otherClinicSession = randomUUID();
    const inactiveClinicSession = randomUUID();

    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES
        ($1, $2, 'Internal Doctor A'),
        ($3, $4, 'Internal Doctor B'),
        ($5, $6, 'Internal Hidden Doctor')`,
      [
        doctorAUser,
        `wu57-a-${doctorAUser}`,
        doctorBUser,
        `wu57-b-${doctorBUser}`,
        hiddenDoctorUser,
        `wu57-hidden-${hiddenDoctorUser}`,
      ],
    );
    await pool.query(
      `INSERT INTO clinics (id, tenant_key, name, status) VALUES
        ($1, $2, 'Availability Clinic A', 'active'),
        ($3, $4, 'Availability Clinic B', 'active'),
        ($5, $6, 'Availability Hidden Clinic', 'inactive')`,
      [
        clinicA,
        `wu57-a-${clinicA}`,
        clinicB,
        `wu57-b-${clinicB}`,
        inactiveClinic,
        `wu57-hidden-${inactiveClinic}`,
      ],
    );
    await pool.query(
      `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
        ($1, $2, 'Dr Available'),
        ($3, $4, 'Dr Other'),
        ($5, $6, 'Dr Hidden')`,
      [doctorA, doctorAUser, doctorB, doctorBUser, hiddenDoctor, hiddenDoctorUser],
    );
    await pool.query(
      `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES
        ($1, $2), ($3, $4), ($5, $6)`,
      [clinicA, doctorA, clinicB, doctorB, inactiveClinic, hiddenDoctor],
    );

    // Deliberately insert later availability before earlier availability.
    await pool.query(
      `INSERT INTO consultation_sessions
        (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
       VALUES
        ($1, $2, $3, '2099-01-03', '2099-01-03T10:00:00Z', '2099-01-03T11:00:00Z', 'paused'),
        ($4, $2, $3, '2099-01-02', '2099-01-02T08:00:00Z', '2099-01-02T09:00:00Z', 'planned'),
        ($5, $2, $3, '2099-01-04', '2099-01-04T08:00:00Z', '2099-01-04T09:00:00Z', 'closed'),
        ($6, $7, $8, '2099-01-02', '2099-01-02T07:00:00Z', '2099-01-02T08:00:00Z', 'open'),
        ($9, $10, $11, '2099-01-02', '2099-01-02T06:00:00Z', '2099-01-02T07:00:00Z', 'open')`,
      [
        sessionLater,
        clinicA,
        doctorA,
        sessionEarlier,
        terminalSession,
        otherClinicSession,
        clinicB,
        doctorB,
        inactiveClinicSession,
        inactiveClinic,
        hiddenDoctor,
      ],
    );

    const service = new PublicDoctorAvailabilityService(pool);
    const before = await mutationCounts();
    const first = await service.listForDoctor(clinicA, doctorA);
    const second = await service.listForDoctor(clinicA, doctorA);
    const after = await mutationCounts();

    expect(first).toEqual([
      {
        serviceDate: '2099-01-02',
        startsAt: '2099-01-02T08:00:00.000Z',
        endsAt: '2099-01-02T09:00:00.000Z',
      },
      {
        serviceDate: '2099-01-03',
        startsAt: '2099-01-03T10:00:00.000Z',
        endsAt: '2099-01-03T11:00:00.000Z',
      },
    ]);
    expect(second).toEqual(first);
    expect(after).toEqual(before);

    const serialized = JSON.stringify(first);
    for (const forbidden of [
      clinicA,
      clinicB,
      inactiveClinic,
      doctorA,
      doctorB,
      hiddenDoctor,
      sessionEarlier,
      sessionLater,
      terminalSession,
      otherClinicSession,
      inactiveClinicSession,
      doctorAUser,
      doctorBUser,
      hiddenDoctorUser,
      'Internal Doctor A',
      'Internal Doctor B',
      'Internal Hidden Doctor',
      'Availability Clinic A',
      'Availability Clinic B',
      'Availability Hidden Clinic',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    expect(await service.listForDoctor(inactiveClinic, hiddenDoctor)).toEqual([]);
    expect(await service.listForDoctor(clinicA, doctorB)).toEqual([]);
  });

  it('keeps same-name clinics and doctors isolated by internal association', async () => {
    const clinicA = randomUUID();
    const clinicB = randomUUID();
    const doctorA = randomUUID();
    const doctorB = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();
    const sessionA = randomUUID();
    const sessionB = randomUUID();

    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES
        ($1, $2, 'Same User'), ($3, $4, 'Same User')`,
      [userA, `wu57-same-a-${userA}`, userB, `wu57-same-b-${userB}`],
    );
    await pool.query(
      `INSERT INTO clinics (id, tenant_key, name) VALUES
        ($1, $2, 'Same Clinic'), ($3, $4, 'Same Clinic')`,
      [clinicA, `wu57-same-a-${clinicA}`, clinicB, `wu57-same-b-${clinicB}`],
    );
    await pool.query(
      `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
        ($1, $2, 'Same Doctor'), ($3, $4, 'Same Doctor')`,
      [doctorA, userA, doctorB, userB],
    );
    await pool.query(
      `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2), ($3, $4)`,
      [clinicA, doctorA, clinicB, doctorB],
    );
    await pool.query(
      `INSERT INTO consultation_sessions
        (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
       VALUES
        ($1, $2, $3, '2099-02-01', '2099-02-01T08:00:00Z', '2099-02-01T09:00:00Z', 'planned'),
        ($4, $5, $6, '2099-02-01', '2099-02-01T12:00:00Z', '2099-02-01T13:00:00Z', 'planned')`,
      [sessionA, clinicA, doctorA, sessionB, clinicB, doctorB],
    );

    const service = new PublicDoctorAvailabilityService(pool);
    expect(await service.listForDoctor(clinicA, doctorA)).toEqual([
      {
        serviceDate: '2099-02-01',
        startsAt: '2099-02-01T08:00:00.000Z',
        endsAt: '2099-02-01T09:00:00.000Z',
      },
    ]);
    expect(await service.listForDoctor(clinicB, doctorB)).toEqual([
      {
        serviceDate: '2099-02-01',
        startsAt: '2099-02-01T12:00:00.000Z',
        endsAt: '2099-02-01T13:00:00.000Z',
      },
    ]);
    expect(await service.listForDoctor(clinicA, doctorB)).toEqual([]);
    expect(await service.listForDoctor(clinicB, doctorA)).toEqual([]);
  });
});
