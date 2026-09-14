import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { GuestAccessService } from '@/modules/guest-access';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import {
  PublicGuestBookingRejectedError,
  PublicGuestBookingService,
  PublicGuestBookingValidationError,
} from '@/modules/public-guest-booking';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const selectionSecret =
  'wu59-selection-secret-that-is-deliberately-long-enough';

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE public_guest_booking_receipts, guest_credentials, guest_exchange_ids,
    audit_events, queue_reorder_receipts, queue_command_receipts, queue_registration_receipts,
    appointments, appointment_booking_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
});
afterAll(async () => pool.end());

async function seed(now: Date) {
  const clinicId = randomUUID();
  const doctorId = randomUUID();
  const doctorUserId = randomUUID();
  const sessionId = randomUUID();
  const startsAt = '2099-03-01T08:00:00.000Z';
  const endsAt = '2099-03-01T09:00:00.000Z';
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, 'Private Doctor')`,
    [doctorUserId, `wu59-doctor-${doctorUserId}`],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name, status) VALUES ($1, $2, 'Private Clinic', 'active')`,
    [clinicId, `wu59-clinic-${clinicId}`],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Private Doctor')`,
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
  const selections = new PublicAvailabilitySelectionService(
    pool,
    selectionSecret,
    () => now,
    60_000,
  );
  const reference = await selections.issue({
    clinicId,
    doctorId,
    sessionId,
    startsAt,
    endsAt,
  });
  if (!reference) throw new Error('selection reference not issued');
  return {
    clinicId,
    doctorId,
    sessionId,
    startsAt,
    endsAt,
    selections,
    reference,
  };
}

function input(reference: string, idempotencyKey = 'guest-booking-1') {
  return {
    selectionReference: reference,
    privateDisplayName: 'Private Guest Name',
    contactPhone: '+213555010101',
    contactEmail: 'Guest@Example.COM',
    preferredLocale: 'fr' as const,
    contactPreference: 'phone' as const,
    idempotencyKey,
    correlationId: 'public-correlation-1',
  };
}

async function counts() {
  const result = await pool.query<Record<string, string>>(`SELECT
    (SELECT count(*)::text FROM public_guest_booking_receipts) receipts,
    (SELECT count(*)::text FROM patient_operational_records) patients,
    (SELECT count(*)::text FROM appointments) appointments,
    (SELECT count(*)::text FROM queue_entries) entries,
    (SELECT count(*)::text FROM guest_credentials) credentials,
    (SELECT count(*)::text FROM audit_events) audits`);
  return result.rows[0];
}

const zeroCounts = {
  receipts: '0',
  patients: '0',
  appointments: '0',
  entries: '0',
  credentials: '0',
  audits: '0',
};

describe('public guest booking transaction', () => {
  it('creates one privacy-safe booking and replays the same usable capability', async () => {
    const now = new Date('2099-02-01T00:00:00.000Z');
    const seeded = await seed(now);
    const service = new PublicGuestBookingService(
      pool,
      seeded.selections,
      () => now,
    );
    const result = await service.book(input(seeded.reference));

    expect(result).toMatchObject({
      serviceDate: '2099-03-01',
      startsAt: seeded.startsAt,
      endsAt: seeded.endsAt,
    });
    expect(result.queueLabel).toMatch(/^W-[A-F0-9]{10}$/);
    expect(result.guestBearer.split('.')).toHaveLength(3);
    expect(await counts()).toEqual({
      receipts: '1',
      patients: '1',
      appointments: '1',
      entries: '1',
      credentials: '1',
      audits: '1',
    });

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      seeded.clinicId,
      seeded.doctorId,
      seeded.sessionId,
      'Private Guest Name',
      '+213555010101',
      'guest@example.com',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const target = await new GuestAccessService(pool).authorize(
      result.guestBearer,
      undefined,
      now,
    );
    expect(target).toMatchObject({
      clinicId: seeded.clinicId,
      sessionId: seeded.sessionId,
    });

    const audit = await pool.query<{
      action: string;
      actor_user_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, actor_user_id, metadata
         FROM audit_events
        WHERE clinic_id = $1`,
      [seeded.clinicId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'public_guest_appointment_booked',
      actor_user_id: null,
    });
    expect(audit.rows[0]?.metadata).toMatchObject({ source: 'guest_public' });
    const auditSerialized = JSON.stringify(audit.rows[0]?.metadata);
    for (const forbidden of [
      'Private Guest Name',
      '+213555010101',
      'guest@example.com',
      seeded.doctorId,
      seeded.sessionId,
    ]) {
      expect(auditSerialized).not.toContain(forbidden);
    }

    expect(await service.book(input(seeded.reference))).toEqual(result);
    expect(await counts()).toEqual({
      receipts: '1',
      patients: '1',
      appointments: '1',
      entries: '1',
      credentials: '1',
      audits: '1',
    });

    await expect(
      service.book({
        ...input(seeded.reference),
        privateDisplayName: 'Changed Guest',
      }),
    ).rejects.toBeInstanceOf(PublicGuestBookingRejectedError);
    expect(await counts()).toEqual({
      receipts: '1',
      patients: '1',
      appointments: '1',
      entries: '1',
      credentials: '1',
      audits: '1',
    });
  });

  it('fails closed before mutation for tampered and stale cross-tenant selections', async () => {
    const now = new Date('2099-02-01T00:00:00.000Z');
    const seeded = await seed(now);
    const service = new PublicGuestBookingService(
      pool,
      seeded.selections,
      () => now,
    );

    const [version, iv, ciphertext, tag] = seeded.reference.split('.');
    if (!version || !iv || !ciphertext || !tag) {
      throw new Error('selection reference has an unexpected format');
    }
    const tamperedCiphertext = `${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}`;
    const tampered = [version, iv, tamperedCiphertext, tag].join('.');
    await expect(
      service.book(input(tampered, 'tampered')),
    ).rejects.toBeInstanceOf(PublicGuestBookingRejectedError);
    expect(await counts()).toEqual(zeroCounts);

    await pool.query(
      `DELETE FROM doctor_clinics WHERE clinic_id = $1 AND doctor_id = $2`,
      [seeded.clinicId, seeded.doctorId],
    );
    await expect(
      service.book(input(seeded.reference, 'association-drift')),
    ).rejects.toBeInstanceOf(PublicGuestBookingRejectedError);
    expect(await counts()).toEqual(zeroCounts);
  });

  it('enforces locale and contact-preference validation before database mutation', async () => {
    const now = new Date('2099-02-01T00:00:00.000Z');
    const seeded = await seed(now);
    const service = new PublicGuestBookingService(
      pool,
      seeded.selections,
      () => now,
    );

    await expect(
      service.book({
        ...input(seeded.reference, 'bad-locale'),
        preferredLocale: 'en' as never,
      }),
    ).rejects.toBeInstanceOf(PublicGuestBookingValidationError);
    await expect(
      service.book({
        ...input(seeded.reference, 'missing-phone'),
        contactPhone: null,
        contactPreference: 'phone',
      }),
    ).rejects.toBeInstanceOf(PublicGuestBookingValidationError);
    await expect(
      service.book({
        ...input(seeded.reference, 'missing-contact'),
        contactPhone: null,
        contactEmail: null,
        contactPreference: 'none',
      }),
    ).rejects.toBeInstanceOf(PublicGuestBookingValidationError);
    expect(await counts()).toEqual(zeroCounts);
  });

  it('converges concurrent equivalents and rolls back every row after a late failure', async () => {
    const now = new Date('2099-02-01T00:00:00.000Z');
    const seeded = await seed(now);
    const service = new PublicGuestBookingService(
      pool,
      seeded.selections,
      () => now,
    );
    const concurrentInput = input(seeded.reference, 'concurrent-booking');
    const [first, second] = await Promise.all([
      service.book(concurrentInput),
      service.book(concurrentInput),
    ]);
    expect(second).toEqual(first);
    expect(await counts()).toEqual({
      receipts: '1',
      patients: '1',
      appointments: '1',
      entries: '1',
      credentials: '1',
      audits: '1',
    });

    await pool.query(`TRUNCATE public_guest_booking_receipts, guest_credentials, audit_events,
      appointments, queue_entries, patient_operational_records CASCADE`);
    const failing = new PublicGuestBookingService(
      pool,
      seeded.selections,
      () => now,
      async () => {
        throw new Error('injected late failure');
      },
    );
    await expect(
      failing.book(input(seeded.reference, 'rollback-booking')),
    ).rejects.toThrow('injected late failure');
    expect(await counts()).toEqual(zeroCounts);
  });
});
