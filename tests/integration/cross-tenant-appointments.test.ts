import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';
import { POST as bookAppointment } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/appointments/route';
import { PATCH as appointmentCommand } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/appointments/[appointmentId]/route';
import { POST as bulkNoShow } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/appointments/bulk-no-show/route';

// TAB-P0-01 (#769 follow-up), appointment family: role checks with VALID
// payloads against a seeded clinic-A session and patient. The generic matrix
// (#767) sends `{}` bodies, so a 400/404 could mask a missing
// requireClinicRole. Booking, lifecycle commands and bulk no-show are
// receptionist/clinic_admin only: doctors and a clinic-B admin must be refused
// with no state change, including through the clinic-B admin's OWN clinic path
// with the clinic-A session and appointment ids (IDOR).
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ORIGIN = 'http://localhost';
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  adminA: randomUUID(),
  adminB: randomUUID(),
  receptionistA: randomUUID(),
  doctorA: randomUUID(),
  profileA: randomUUID(),
  patientA: randomUUID(),
  patientA2: randomUUID(),
  session: randomUUID(),
};
const subjects = {
  adminA: 'ap-admin-a',
  adminB: 'ap-admin-b',
  receptionistA: 'ap-reception-a',
  doctorA: 'ap-doctor-a',
};
let keySeq = 0;

async function cookieFor(subject: string): Promise<string> {
  const token = await createStaffSessionToken(
    subject,
    new Date(Date.now() + 60_000),
  );
  return `tabibi_staff_session=${token}`;
}

async function call(
  handler: (req: Request, ctx: never) => Promise<Response>,
  url: string,
  method: string,
  subject: string,
  params: Record<string, string>,
  body: unknown,
): Promise<number> {
  const response = await handler(
    new Request(url, {
      method,
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': `ap-${++keySeq}`,
        cookie: await cookieFor(subject),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(params) } as never,
  );
  return response.status;
}

const sessionBase = (clinicId: string) =>
  `${ORIGIN}/api/clinics/${clinicId}/sessions/${ids.session}/appointments`;

const bookingBody = (hour: number) => ({
  patientId: hour === 9 ? ids.patientA : ids.patientA2,
  scheduledStartAt: `2026-01-05T${String(hour).padStart(2, '0')}:00:00.000Z`,
  scheduledEndAt: `2026-01-05T${String(hour).padStart(2, '0')}:15:00.000Z`,
  contactPreference: 'none',
});

const book = (subject: string, hour: number, clinicId = ids.clinicA) =>
  call(
    bookAppointment as never,
    sessionBase(clinicId),
    'POST',
    subject,
    { clinicId, sessionId: ids.session },
    bookingBody(hour),
  );

const command = (
  subject: string,
  appointmentId: string,
  body: unknown,
  clinicId = ids.clinicA,
) =>
  call(
    appointmentCommand as never,
    `${sessionBase(clinicId)}/${appointmentId}`,
    'PATCH',
    subject,
    { clinicId, sessionId: ids.session, appointmentId },
    body,
  );

const bulk = (subject: string, clinicId = ids.clinicA) =>
  call(
    bulkNoShow as never,
    `${sessionBase(clinicId)}/bulk-no-show`,
    'POST',
    subject,
    { clinicId, sessionId: ids.session },
    { reason: 'Did not arrive' },
  );

async function appointments(): Promise<{ id: string; status: string }[]> {
  const r = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM appointments WHERE clinic_id = $1
      ORDER BY scheduled_start_at`,
    [ids.clinicA],
  );
  return r.rows;
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'cross-tenant-appointments-secret-at-least-32-chars';
  await migrate();
  await pool.query(
    `TRUNCATE audit_events, staff_sessions, appointment_booking_receipts,
       appointments, queue_command_receipts, queue_reorder_receipts,
       queue_registration_receipts, queue_entries, patient_operational_records,
       session_command_receipts, consultation_sessions, schedule_templates,
       clinic_memberships, doctor_clinics, doctor_profiles, clinics, users CASCADE`,
  );
  for (const [key, subject] of Object.entries(subjects)) {
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $2)`,
      [ids[key as keyof typeof subjects], subject],
    );
  }
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'ap-a', 'A'), ($2, 'ap-b', 'B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($2, $4, 'clinic_admin'),
       ($1, $5, 'receptionist'), ($1, $6, 'doctor')`,
    [
      ids.clinicA,
      ids.clinicB,
      ids.adminA,
      ids.adminB,
      ids.receptionistA,
      ids.doctorA,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Dr A')`,
    [ids.profileA, ids.doctorA],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
    [ids.clinicA, ids.profileA],
  );
  await pool.query(
    `INSERT INTO consultation_sessions (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES ($1, $2, $3, '2026-01-05', '2026-01-05 09:00Z', '2026-01-05 12:00Z', 'open')`,
    [ids.session, ids.clinicA, ids.profileA],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
       (id, clinic_id, private_display_name, preferred_locale)
     VALUES ($1, $3, 'Patient A', 'fr'), ($2, $3, 'Patient A2', 'fr')`,
    [ids.patientA, ids.patientA2, ids.clinicA],
  );
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('appointment routes enforce the target clinic role', () => {
  it('booking is 403 for a clinic-B admin and a clinic-A doctor, 409 through clinic B, and creates nothing', async () => {
    expect(await book(subjects.adminB, 9)).toBe(403);
    expect(await book(subjects.doctorA, 9)).toBe(403);
    expect(await book(subjects.adminB, 9, ids.clinicB)).toBe(409);
    expect(await appointments()).toEqual([]);
    expect(await book(subjects.receptionistA, 9)).toBe(201);
    expect(await book(subjects.adminA, 10)).toBe(201);
    expect((await appointments()).map((a) => a.status)).toEqual([
      'confirmed',
      'confirmed',
    ]);
  });

  it('lifecycle commands are refused for outsiders and doctors and apply for staff roles', async () => {
    const [first] = await appointments();
    const cancel = { command: 'cancel', reason: 'Patient called' };
    expect(await command(subjects.adminB, first!.id, cancel)).toBe(403);
    expect(await command(subjects.doctorA, first!.id, cancel)).toBe(403);
    expect(
      await command(subjects.adminB, first!.id, cancel, ids.clinicB),
    ).toBeGreaterThanOrEqual(400);
    expect((await appointments())[0]!.status).toBe('confirmed');

    expect(await command(subjects.receptionistA, first!.id, cancel)).toBe(200);
    expect((await appointments())[0]!.status).toBe('cancelled');

    const restore = { command: 'restore', reason: 'Booked in error' };
    expect(await command(subjects.doctorA, first!.id, restore)).toBe(403);
    expect(await command(subjects.adminB, first!.id, restore)).toBe(403);
    expect((await appointments())[0]!.status).toBe('cancelled');
    expect(await command(subjects.adminA, first!.id, restore)).toBe(200);
    expect((await appointments())[0]!.status).toBe('confirmed');
  });

  it('bulk no-show is refused for outsiders and doctors without touching waiting appointments', async () => {
    const before = await appointments();
    expect(await bulk(subjects.adminB)).toBe(403);
    expect(await bulk(subjects.doctorA)).toBe(403);
    expect(await bulk(subjects.adminB, ids.clinicB)).toBe(409);
    expect(await appointments()).toEqual(before);
    expect(await bulk(subjects.receptionistA)).toBe(200);
    expect((await appointments()).map((a) => a.status)).toEqual([
      'no_show',
      'no_show',
    ]);
  });
});
