import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { POST as guestBookingRoute } from '@/app/api/public/bookings/route';
import { GuestAccessService } from '@/modules/guest-access';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import { closePool } from '@/platform/database/pool';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const selectionSecret =
  'wu59-route-test-secret-that-is-deliberately-long-enough';

beforeAll(async () => migrate());
beforeEach(async () => {
  process.env.PUBLIC_AVAILABILITY_SELECTION_SECRET = selectionSecret;
  await pool.query(`TRUNCATE public_guest_booking_receipts, guest_credentials, guest_exchange_ids,
    audit_events, queue_reorder_receipts, queue_command_receipts, queue_registration_receipts,
    appointments, appointment_booking_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
});
afterAll(async () => {
  await closePool();
  await pool.end();
});

async function seed() {
  const clinicId = randomUUID();
  const doctorId = randomUUID();
  const doctorUserId = randomUUID();
  const sessionId = randomUUID();
  const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, 'Route Doctor')`,
    [doctorUserId, `wu59-route-doctor-${doctorUserId}`],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name, status) VALUES ($1, $2, 'Route Clinic', 'active')`,
    [clinicId, `wu59-route-clinic-${clinicId}`],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Route Doctor')`,
    [doctorId, doctorUserId],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
    [clinicId, doctorId],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES ($1, $2, $3, (now() AT TIME ZONE 'utc')::date, $4, $5, 'planned')`,
    [sessionId, clinicId, doctorId, startsAt, endsAt],
  );
  const selections = new PublicAvailabilitySelectionService(
    pool,
    selectionSecret,
  );
  const reference = await selections.issue({
    clinicId,
    doctorId,
    sessionId,
    startsAt,
    endsAt,
  });
  if (!reference) throw new Error('selection reference not issued');
  return { clinicId, doctorId, sessionId, startsAt, endsAt, reference };
}

function body(reference: string, extra: Record<string, unknown> = {}) {
  return {
    selectionReference: reference,
    privateDisplayName: 'Route Guest Name',
    contactPhone: '+213555020202',
    contactEmail: 'route-guest@example.com',
    preferredLocale: 'ar' as const,
    contactPreference: 'phone' as const,
    ...extra,
  };
}

function postRequest(
  payload: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request('http://localhost/api/public/bookings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'route-booking-1',
      ...headers,
    },
    body: JSON.stringify(payload),
  });
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

describe('public guest booking HTTP route', () => {
  it('books through the public route, derives correlation from request context, and serializes only the public result', async () => {
    const seeded = await seed();
    const response = await guestBookingRoute(
      postRequest(body(seeded.reference), {
        'x-request-id': 'route-correlation-1',
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('route-correlation-1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const responseBody = await response.json();
    expect(Object.keys(responseBody).sort()).toEqual(
      [
        'endsAt',
        'guestAccessExpiresAt',
        'guestBearer',
        'queueLabel',
        'serviceDate',
        'startsAt',
      ].sort(),
    );
    expect(responseBody.startsAt).toBe(seeded.startsAt);
    expect(responseBody.endsAt).toBe(seeded.endsAt);
    expect(responseBody.guestBearer.split('.')).toHaveLength(3);

    const serialized = JSON.stringify(responseBody);
    for (const forbidden of [
      seeded.clinicId,
      seeded.doctorId,
      seeded.sessionId,
      'Route Guest Name',
      '+213555020202',
      'route-guest@example.com',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const target = await new GuestAccessService(pool).authorize(
      responseBody.guestBearer,
    );
    expect(target).toMatchObject({
      clinicId: seeded.clinicId,
      sessionId: seeded.sessionId,
    });

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE clinic_id = $1`,
      [seeded.clinicId],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({
      correlationId: 'route-correlation-1',
    });
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain(
      'route-guest@example.com',
    );
  });

  it('replays the same result for a repeated idempotency-key header without extra mutation', async () => {
    const seeded = await seed();
    const first = await guestBookingRoute(
      postRequest(body(seeded.reference), {
        'x-request-id': 'route-replay-1',
      }),
    );
    const firstBody = await first.json();
    expect(first.status).toBe(201);

    const second = await guestBookingRoute(
      postRequest(body(seeded.reference), {
        'x-request-id': 'route-replay-2',
      }),
    );
    expect(second.status).toBe(201);
    await expect(second.json()).resolves.toEqual(firstBody);
    expect(await counts()).toEqual({
      receipts: '1',
      patients: '1',
      appointments: '1',
      entries: '1',
      credentials: '1',
      audits: '1',
    });
  });

  it('rejects non-allowlisted public body fields before mutation', async () => {
    const seeded = await seed();
    const response = await guestBookingRoute(
      postRequest(body(seeded.reference, { correlationId: 'guest@example.com' }), {
        'idempotency-key': 'route-extra-field',
        'x-request-id': 'route-extra-field-request',
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      status: 'rejected',
      requestId: 'route-extra-field-request',
    });
    expect(await counts()).toEqual(zeroCounts);
  });

  it('returns a generic 400 for a malformed public body without mutating anything', async () => {
    const seeded = await seed();
    const response = await guestBookingRoute(
      postRequest(body(seeded.reference, { preferredLocale: 'en' }), {
        'idempotency-key': 'route-bad-locale',
        'x-request-id': 'route-bad-locale-request',
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      status: 'rejected',
      requestId: 'route-bad-locale-request',
    });
    expect(await counts()).toEqual(zeroCounts);
  });

  it('returns the same generic response without mutation for unrelated authoritative rejection causes', async () => {
    const seeded = await seed();
    const expected = {
      status: 'rejected',
      requestId: 'route-authoritative-rejection',
    };

    const malformed = await guestBookingRoute(
      postRequest(body('not-a-selection-reference'), {
        'idempotency-key': 'route-malformed',
        'x-request-id': 'route-authoritative-rejection',
      }),
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual(expected);

    await pool.query(`UPDATE clinics SET status = 'inactive' WHERE id = $1`, [
      seeded.clinicId,
    ]);
    const inactiveClinic = await guestBookingRoute(
      postRequest(body(seeded.reference), {
        'idempotency-key': 'route-inactive-clinic',
        'x-request-id': 'route-authoritative-rejection',
      }),
    );
    expect(inactiveClinic.status).toBe(400);
    await expect(inactiveClinic.json()).resolves.toEqual(expected);

    expect(await counts()).toEqual(zeroCounts);
  });
});
