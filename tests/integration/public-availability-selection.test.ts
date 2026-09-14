import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const secret = 'wu58-test-secret-that-is-deliberately-long-enough';

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

describe('opaque public availability selection reference', () => {
  it('resolves current durable truth, fails closed after drift, and never exposes internal identity', async () => {
    const clinicId = randomUUID();
    const doctorId = randomUUID();
    const doctorUserId = randomUUID();
    const sessionId = randomUUID();
    const startsAt = '2099-03-01T08:00:00.000Z';
    const endsAt = '2099-03-01T09:00:00.000Z';
    let now = new Date('2099-02-01T00:00:00.000Z');

    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, 'Private Doctor Name')`,
      [doctorUserId, `wu58-user-${doctorUserId}`],
    );
    await pool.query(
      `INSERT INTO clinics (id, tenant_key, name, status) VALUES ($1, $2, 'Private Clinic Name', 'active')`,
      [clinicId, `wu58-tenant-${clinicId}`],
    );
    await pool.query(
      `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Private Doctor Name')`,
      [doctorId, doctorUserId],
    );
    await pool.query(
      `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
      [clinicId, doctorId],
    );
    await pool.query(
      `INSERT INTO consultation_sessions
        (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
       VALUES ($1, $2, $3, '2099-03-01', $4, $5, 'planned')`,
      [sessionId, clinicId, doctorId, startsAt, endsAt],
    );

    const service = new PublicAvailabilitySelectionService(
      pool,
      secret,
      () => now,
      60_000,
    );
    const input = { clinicId, doctorId, sessionId, startsAt, endsAt };
    const before = await mutationCounts();
    const reference = await service.issue(input);
    expect(reference).not.toBeNull();
    expect(await service.resolve(reference!)).toEqual({
      serviceDate: '2099-03-01',
      startsAt,
      endsAt,
    });
    expect(await service.resolve(reference!)).toEqual({
      serviceDate: '2099-03-01',
      startsAt,
      endsAt,
    });
    expect(await mutationCounts()).toEqual(before);

    const publicData = JSON.stringify({
      reference,
      resolved: await service.resolve(reference!),
    });
    for (const forbidden of [
      clinicId,
      doctorId,
      doctorUserId,
      sessionId,
      'Private Doctor Name',
      'Private Clinic Name',
      `wu58-tenant-${clinicId}`,
    ]) {
      expect(publicData).not.toContain(forbidden);
    }

    expect(await service.resolve(`${reference}tampered`)).toBeNull();
    expect(await service.resolve('not-a-reference')).toBeNull();
    expect(
      await service.resolve(`v2.${reference!.split('.').slice(1).join('.')}`),
    ).toBeNull();

    await pool.query(`UPDATE clinics SET status = 'inactive' WHERE id = $1`, [
      clinicId,
    ]);
    expect(await service.resolve(reference!)).toBeNull();
    await pool.query(`UPDATE clinics SET status = 'active' WHERE id = $1`, [
      clinicId,
    ]);

    await pool.query(
      `DELETE FROM doctor_clinics WHERE clinic_id = $1 AND doctor_id = $2`,
      [clinicId, doctorId],
    );
    expect(await service.resolve(reference!)).toBeNull();
    await pool.query(
      `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
      [clinicId, doctorId],
    );

    await pool.query(
      `UPDATE consultation_sessions SET status = 'closed' WHERE id = $1`,
      [sessionId],
    );
    expect(await service.resolve(reference!)).toBeNull();
    await pool.query(
      `UPDATE consultation_sessions SET status = 'planned' WHERE id = $1`,
      [sessionId],
    );

    await pool.query(
      `UPDATE consultation_sessions SET starts_at = '2099-03-01T08:15:00Z' WHERE id = $1`,
      [sessionId],
    );
    expect(await service.resolve(reference!)).toBeNull();
    await pool.query(
      `UPDATE consultation_sessions SET starts_at = $2 WHERE id = $1`,
      [sessionId, startsAt],
    );

    now = new Date('2099-02-01T00:01:00.000Z');
    expect(await service.resolve(reference!)).toBeNull();
  });

  it('keeps same-name clinics and doctors isolated by encrypted internal identity', async () => {
    const clinicA = randomUUID();
    const clinicB = randomUUID();
    const doctorA = randomUUID();
    const doctorB = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    const startsA = '2099-04-01T08:00:00.000Z';
    const endsA = '2099-04-01T09:00:00.000Z';
    const startsB = '2099-04-01T12:00:00.000Z';
    const endsB = '2099-04-01T13:00:00.000Z';
    const now = new Date('2099-03-01T00:00:00.000Z');

    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES
        ($1, $2, 'Same Private Doctor'), ($3, $4, 'Same Private Doctor')`,
      [userA, `wu58-a-${userA}`, userB, `wu58-b-${userB}`],
    );
    await pool.query(
      `INSERT INTO clinics (id, tenant_key, name) VALUES
        ($1, $2, 'Same Clinic'), ($3, $4, 'Same Clinic')`,
      [clinicA, `wu58-a-${clinicA}`, clinicB, `wu58-b-${clinicB}`],
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
        ($1, $2, $3, '2099-04-01', $4, $5, 'planned'),
        ($6, $7, $8, '2099-04-01', $9, $10, 'planned')`,
      [
        sessionA,
        clinicA,
        doctorA,
        startsA,
        endsA,
        sessionB,
        clinicB,
        doctorB,
        startsB,
        endsB,
      ],
    );

    const service = new PublicAvailabilitySelectionService(
      pool,
      secret,
      () => now,
    );
    const referenceA = await service.issue({
      clinicId: clinicA,
      doctorId: doctorA,
      sessionId: sessionA,
      startsAt: startsA,
      endsAt: endsA,
    });
    const referenceB = await service.issue({
      clinicId: clinicB,
      doctorId: doctorB,
      sessionId: sessionB,
      startsAt: startsB,
      endsAt: endsB,
    });

    expect(referenceA).not.toEqual(referenceB);
    expect(await service.resolve(referenceA!)).toEqual({
      serviceDate: '2099-04-01',
      startsAt: startsA,
      endsAt: endsA,
    });
    expect(await service.resolve(referenceB!)).toEqual({
      serviceDate: '2099-04-01',
      startsAt: startsB,
      endsAt: endsB,
    });

    expect(
      await service.issue({
        clinicId: clinicA,
        doctorId: doctorB,
        sessionId: sessionB,
        startsAt: startsB,
        endsAt: endsB,
      }),
    ).toBeNull();
  });
});
