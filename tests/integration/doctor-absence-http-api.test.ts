import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import * as absenceItem from '@/app/api/clinics/[clinicId]/doctors/[doctorId]/absences/[absenceDate]/route';
import * as absences from '@/app/api/clinics/[clinicId]/doctors/[doctorId]/absences/route';
import * as generations from '@/app/api/clinics/[clinicId]/schedule-generations/route';
import * as templates from '@/app/api/clinics/[clinicId]/schedule-templates/route';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

// TAB-P0-02 (#659): per-doctor absence days (#655) over the staff HTTP
// boundary. Authorization stays in the service; the routes add origin/session
// checks, input validation (400, never 500) and error mapping (403/409).
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  otherAdmin: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  otherDoctorUser: randomUUID(),
  otherDoctor: randomUUID(),
};
const MONDAY = '2026-09-07';
const ORIGIN = 'http://localhost';
type Params = Record<string, string>;
type Handler<P extends Params> = (
  request: Request,
  context: { params: Promise<P> },
) => Promise<Response>;

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'doctor-absence-http-api-test-secret-at-least-32-chars';
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, doctor_absences, clinic_closures,
    staff_sessions, session_command_receipts, consultation_sessions,
    schedule_templates, doctor_clinics, doctor_profiles, clinic_memberships,
    clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'abs-admin', 'Admin'), ($2, 'abs-other-admin', 'Other Admin'),
       ($3, 'abs-receptionist', 'Receptionist'), ($4, 'abs-doctor', 'Doctor'),
       ($5, 'abs-other-doctor', 'Other Doctor')`,
    [
      ids.admin,
      ids.otherAdmin,
      ids.receptionist,
      ids.doctorUser,
      ids.otherDoctorUser,
    ],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'abs-clinic', 'Clinic'), ($2, 'abs-other-clinic', 'Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($1, $4, 'receptionist'), ($1, $5, 'doctor'),
       ($2, $6, 'clinic_admin'), ($2, $7, 'doctor')`,
    [
      ids.clinic,
      ids.otherClinic,
      ids.admin,
      ids.receptionist,
      ids.doctorUser,
      ids.otherAdmin,
      ids.otherDoctorUser,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
       ($1, $2, 'Doctor'), ($3, $4, 'Other Doctor')`,
    [ids.doctor, ids.doctorUser, ids.otherDoctor, ids.otherDoctorUser],
  );
  // The other doctor is associated with the other clinic only.
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2), ($3, $4)`,
    [ids.clinic, ids.doctor, ids.otherClinic, ids.otherDoctor],
  );
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

async function call<P extends Params>(
  handler: Handler<P>,
  subject: string,
  path: string,
  params: P,
  method: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
  const cookie = `tabibi_staff_session=${await createStaffSessionToken(
    subject,
    new Date(Date.now() + 60_000),
  )}`;
  const res = await handler(
    new Request(`${ORIGIN}/api/clinics/${params.clinicId}/${path}`, {
      method,
      headers: {
        cookie,
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) },
  );
  return { status: res.status, json: await res.json(), res };
}

function add(
  subject: string,
  body: unknown,
  doctorId: string = ids.doctor,
  clinicId: string = ids.clinic,
) {
  return call(
    absences.POST,
    subject,
    `doctors/${doctorId}/absences`,
    { clinicId, doctorId },
    'POST',
    body,
  );
}

function list(subject: string, doctorId: string = ids.doctor, clinicId: string = ids.clinic) {
  return call(
    absences.GET,
    subject,
    `doctors/${doctorId}/absences`,
    { clinicId, doctorId },
    'GET',
  );
}

function remove(subject: string, absenceDate: string, doctorId: string = ids.doctor) {
  return call(
    absenceItem.DELETE,
    subject,
    `doctors/${doctorId}/absences/${absenceDate}`,
    { clinicId: ids.clinic, doctorId, absenceDate },
    'DELETE',
  );
}

async function absenceRows() {
  const rows = await pool.query(
    `SELECT clinic_id, doctor_id, absence_date::text FROM doctor_absences
      ORDER BY absence_date`,
  );
  return rows.rows;
}

describe('doctor absence routes', () => {
  it('adds, lists and removes an absence day idempotently', async () => {
    const first = await add('abs-admin', { absenceDate: MONDAY });
    expect(first.status).toBe(201);
    expect(first.res.headers.get('cache-control')).toBe('no-store');
    expect(first.json).toEqual({
      doctorId: ids.doctor,
      absenceDate: MONDAY,
      created: true,
    });
    const again = await add('abs-admin', { absenceDate: MONDAY });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({
      doctorId: ids.doctor,
      absenceDate: MONDAY,
      created: false,
    });

    const listed = await list('abs-receptionist');
    expect(listed.status).toBe(200);
    expect(listed.res.headers.get('cache-control')).toBe('no-store');
    expect(listed.json).toEqual({ absences: [MONDAY] });

    const removed = await remove('abs-admin', MONDAY);
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({
      doctorId: ids.doctor,
      absenceDate: MONDAY,
      removed: true,
    });
    expect((await remove('abs-admin', MONDAY)).json).toEqual({
      doctorId: ids.doctor,
      absenceDate: MONDAY,
      removed: false,
    });
    expect(await absenceRows()).toEqual([]);
  });

  it('lets the doctor add and remove their own absence', async () => {
    expect((await add('abs-doctor', { absenceDate: MONDAY })).status).toBe(201);
    expect((await remove('abs-doctor', MONDAY)).status).toBe(200);
    expect(await absenceRows()).toEqual([]);
  });

  it('denies receptionist writes, other-clinic admins and non-associated doctors with 403', async () => {
    expect((await add('abs-receptionist', { absenceDate: MONDAY })).status).toBe(
      403,
    );
    expect((await add('abs-other-admin', { absenceDate: MONDAY })).status).toBe(
      403,
    );
    expect((await list('abs-other-admin')).status).toBe(403);
    // Another clinic's doctor, addressed through this clinic.
    const foreign = await add('abs-admin', { absenceDate: MONDAY }, ids.otherDoctor);
    expect(foreign.status).toBe(403);
    expect(foreign.json.error).toBe('forbidden');
    expect((await list('abs-admin', ids.otherDoctor)).status).toBe(403);
    expect((await list('abs-admin', randomUUID())).status).toBe(403);

    await add('abs-admin', { absenceDate: MONDAY });
    expect((await remove('abs-receptionist', MONDAY)).status).toBe(403);
    expect(await absenceRows()).toEqual([
      { clinic_id: ids.clinic, doctor_id: ids.doctor, absence_date: MONDAY },
    ]);
  });

  it('maps an absence over a planned day to 409 and writes nothing', async () => {
    const template = await call(
      templates.POST,
      'abs-admin',
      'schedule-templates',
      { clinicId: ids.clinic },
      'POST',
      {
        doctorId: ids.doctor,
        weekday: 1,
        localStartTime: '09:00',
        localEndTime: '12:00',
        occurrenceIndex: 0,
      },
    );
    expect(template.status).toBe(201);
    const generated = await call(
      generations.POST,
      'abs-admin',
      'schedule-generations',
      { clinicId: ids.clinic },
      'POST',
      { doctorId: ids.doctor, startDate: MONDAY, daysAhead: 7 },
    );
    expect(generated.json).toEqual({ generated: 1 });
    const response = await add('abs-admin', { absenceDate: MONDAY });
    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({
      error: 'conflict',
      message: 'Doctor already has non-cancelled sessions on this absence day',
    });
    expect(await absenceRows()).toEqual([]);
  });

  it.each([
    ['February 29 of a non-leap year', { absenceDate: '2026-02-29' }],
    ['numeric day', { absenceDate: 20260907 }],
    ['unknown field', { absenceDate: MONDAY, doctorId: ids.otherDoctor }],
    ['missing day', {}],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const response = await add('abs-admin', body);
    expect(response.status).toBe(400);
    expect(response.json.error).toBe('invalid_request');
    expect(await absenceRows()).toEqual([]);
  });

  it('rejects malformed doctor ids, clinic ids and removal days with 400', async () => {
    expect((await add('abs-admin', { absenceDate: MONDAY }, 'nope')).status).toBe(
      400,
    );
    expect((await list('abs-admin', 'nope')).status).toBe(400);
    expect((await list('abs-admin', ids.doctor, 'not-a-clinic')).status).toBe(
      400,
    );
    expect((await remove('abs-admin', '2026-13-01')).status).toBe(400);
    expect((await remove('abs-admin', MONDAY, 'nope')).status).toBe(400);
  });
});
