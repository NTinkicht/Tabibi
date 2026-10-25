import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import * as closureItem from '@/app/api/clinics/[clinicId]/closures/[closureDate]/route';
import * as closures from '@/app/api/clinics/[clinicId]/closures/route';
import * as generations from '@/app/api/clinics/[clinicId]/schedule-generations/route';
import * as templateItem from '@/app/api/clinics/[clinicId]/schedule-templates/[templateId]/route';
import * as templates from '@/app/api/clinics/[clinicId]/schedule-templates/route';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

// TAB-P0-02 (#657): the scheduling service is reachable over the staff HTTP
// boundary. Authorization stays in the service; the routes add origin/session
// checks, input validation (400, never 500) and error mapping (403/404/409).
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  otherAdmin: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
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
    'scheduling-http-api-test-secret-at-least-32-chars';
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, clinic_closures, staff_sessions,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'http-admin', 'Admin'), ($2, 'http-other-admin', 'Other Admin'),
       ($3, 'http-receptionist', 'Receptionist'), ($4, 'http-doctor', 'Doctor')`,
    [ids.admin, ids.otherAdmin, ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'http-clinic', 'Clinic'), ($2, 'http-other-clinic', 'Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($1, $4, 'receptionist'), ($1, $5, 'doctor'),
       ($2, $6, 'clinic_admin'), ($2, $5, 'doctor')`,
    [
      ids.clinic,
      ids.otherClinic,
      ids.admin,
      ids.receptionist,
      ids.doctorUser,
      ids.otherAdmin,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $3), ($2, $3)`,
    [ids.clinic, ids.otherClinic, ids.doctor],
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

const template = {
  weekday: 1,
  localStartTime: '09:00',
  localEndTime: '12:00',
  occurrenceIndex: 0,
};

function createTemplate(subject = 'http-admin', overrides = {}) {
  return call(
    templates.POST,
    subject,
    'schedule-templates',
    { clinicId: ids.clinic },
    'POST',
    { doctorId: ids.doctor, ...template, ...overrides },
  );
}

function setActive(templateId: string, active: unknown, clinicId = ids.clinic) {
  const subject = clinicId === ids.clinic ? 'http-admin' : 'http-other-admin';
  return call(
    templateItem.PATCH,
    subject,
    `schedule-templates/${templateId}`,
    { clinicId, templateId },
    'PATCH',
    { active },
  );
}

describe('schedule template routes', () => {
  it('creates, lists, deactivates and reactivates a template', async () => {
    const created = await createTemplate();
    expect(created.status).toBe(201);
    expect(created.res.headers.get('cache-control')).toBe('no-store');
    const id = (created.json.template as { id: string }).id;
    expect(created.json.template).toEqual({
      id,
      clinicId: ids.clinic,
      doctorId: ids.doctor,
      weekday: 1,
      localStartTime: '09:00:00',
      localEndTime: '12:00:00',
      occurrenceIndex: 0,
      active: true,
    });

    const listed = await call(
      templates.GET,
      'http-receptionist',
      `schedule-templates?doctorId=${ids.doctor}`,
      { clinicId: ids.clinic },
      'GET',
    );
    expect(listed.status).toBe(200);
    expect(listed.json.templates).toEqual([created.json.template]);

    const off = await setActive(id, false);
    expect(off.status).toBe(200);
    expect(off.json.template).toMatchObject({ id, active: false });
    const on = await setActive(id, true);
    expect(on.json.template).toMatchObject({ id, active: true });
  });

  it('maps an overlapping template to 409 and a receptionist write to 403', async () => {
    expect((await createTemplate()).status).toBe(201);
    const overlap = await createTemplate('http-admin', {
      localStartTime: '11:00',
      localEndTime: '13:00',
      occurrenceIndex: 1,
    });
    expect(overlap.status).toBe(409);
    expect(overlap.json.error).toBe('conflict');
    const denied = await createTemplate('http-receptionist', {
      weekday: 2,
    });
    expect(denied.status).toBe(403);
    expect(denied.json.error).toBe('forbidden');
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM schedule_templates',
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('maps a reused weekday/occurrence index to 409, even for an adjacent range or a deactivated template', async () => {
    const created = await createTemplate();
    const id = (created.json.template as { id: string }).id;
    const adjacent = await createTemplate('http-admin', {
      localStartTime: '12:00',
      localEndTime: '15:00',
    });
    expect(adjacent.status).toBe(409);
    expect(adjacent.json).toMatchObject({
      error: 'conflict',
      message:
        'Doctor already has a template with this weekday and occurrence index',
    });
    expect((await setActive(id, false)).status).toBe(200);
    const replacement = await createTemplate('http-admin', {
      localStartTime: '14:00',
      localEndTime: '17:00',
    });
    expect(replacement.status).toBe(409);
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM schedule_templates',
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('answers unknown, malformed and other-clinic template ids with the same 404', async () => {
    const created = await createTemplate();
    const id = (created.json.template as { id: string }).id;
    const otherClinic = await setActive(id, false, ids.otherClinic);
    const unknown = await setActive(randomUUID(), false);
    const malformed = await setActive('not-a-uuid', false);
    for (const response of [otherClinic, unknown, malformed]) {
      expect(response.status).toBe(404);
      expect(response.json).toMatchObject({
        error: 'not_found',
        message: 'Schedule template not found',
      });
    }
    const row = await pool.query('SELECT active FROM schedule_templates');
    expect(row.rows[0].active).toBe(true);
  });

  it.each([
    ['weekday 7', { weekday: 7 }],
    ['time 24:00', { localEndTime: '24:00' }],
    ['end before start', { localStartTime: '12:00', localEndTime: '09:00' }],
    ['negative occurrence', { occurrenceIndex: -1 }],
    ['malformed doctor id', { doctorId: 'nope' }],
    ['unknown field', { clinicId: ids.otherClinic }],
  ])('rejects %s with 400 and writes nothing', async (_label, overrides) => {
    const response = await createTemplate('http-admin', overrides);
    expect(response.status).toBe(400);
    expect(response.json.error).toBe('invalid_request');
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM schedule_templates',
    );
    expect(count.rows[0].n).toBe(0);
  });

  it('rejects a non-boolean active flag and a malformed doctorId query with 400', async () => {
    const id = ((await createTemplate()).json.template as { id: string }).id;
    expect((await setActive(id, 'false')).status).toBe(400);
    const listed = await call(
      templates.GET,
      'http-admin',
      'schedule-templates?doctorId=nope',
      { clinicId: ids.clinic },
      'GET',
    );
    expect(listed.status).toBe(400);
  });

  it('rejects a malformed clinic id with 400', async () => {
    const response = await call(
      templates.GET,
      'http-admin',
      `schedule-templates?doctorId=${ids.doctor}`,
      { clinicId: 'not-a-clinic' },
      'GET',
    );
    expect(response.status).toBe(400);
  });
});

describe('session generation route', () => {
  function generate(subject: string, body: unknown, clinicId = ids.clinic) {
    return call(
      generations.POST,
      subject,
      'schedule-generations',
      { clinicId },
      'POST',
      body,
    );
  }

  it('generates once and is idempotent on retry', async () => {
    await createTemplate();
    const body = { doctorId: ids.doctor, startDate: MONDAY, daysAhead: 14 };
    const first = await generate('http-admin', body);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ generated: 2 });
    expect((await generate('http-admin', body)).json).toEqual({ generated: 0 });
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM consultation_sessions',
    );
    expect(count.rows[0].n).toBe(2);
  });

  it('denies a receptionist and another clinic admin acting on this clinic', async () => {
    await createTemplate();
    const body = { doctorId: ids.doctor, startDate: MONDAY };
    expect((await generate('http-receptionist', body)).status).toBe(403);
    expect((await generate('http-other-admin', body)).status).toBe(403);
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM consultation_sessions',
    );
    expect(count.rows[0].n).toBe(0);
  });

  it.each([
    ['February 30', { startDate: '2026-02-30' }],
    ['daysAhead 6', { daysAhead: 6 }],
    ['daysAhead 367', { daysAhead: 367 }],
    ['fractional daysAhead', { daysAhead: 7.5 }],
  ])('rejects %s with 400', async (_label, overrides) => {
    const response = await generate('http-admin', {
      doctorId: ids.doctor,
      startDate: MONDAY,
      ...overrides,
    });
    expect(response.status).toBe(400);
    expect(response.json.error).toBe('invalid_request');
  });
});

describe('clinic closure routes', () => {
  function add(subject: string, closureDate: unknown, clinicId = ids.clinic) {
    return call(closures.POST, subject, 'closures', { clinicId }, 'POST', {
      closureDate,
    });
  }
  function remove(subject: string, closureDate: string) {
    return call(
      closureItem.DELETE,
      subject,
      `closures/${closureDate}`,
      { clinicId: ids.clinic, closureDate },
      'DELETE',
    );
  }

  it('adds, lists and removes a closure day idempotently', async () => {
    const first = await add('http-admin', MONDAY);
    expect(first.status).toBe(201);
    expect(first.json).toEqual({ closureDate: MONDAY, created: true });
    const again = await add('http-admin', MONDAY);
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ closureDate: MONDAY, created: false });

    const listed = await call(
      closures.GET,
      'http-receptionist',
      'closures',
      { clinicId: ids.clinic },
      'GET',
    );
    expect(listed.json).toEqual({ closures: [MONDAY] });

    expect((await remove('http-admin', MONDAY)).json).toEqual({
      closureDate: MONDAY,
      removed: true,
    });
    expect((await remove('http-admin', MONDAY)).json).toEqual({
      closureDate: MONDAY,
      removed: false,
    });
  });

  it('maps a closure over a planned day to 409', async () => {
    await createTemplate();
    await call(
      generations.POST,
      'http-admin',
      'schedule-generations',
      { clinicId: ids.clinic },
      'POST',
      { doctorId: ids.doctor, startDate: MONDAY },
    );
    const response = await add('http-admin', MONDAY);
    expect(response.status).toBe(409);
    expect(response.json.error).toBe('conflict');
  });

  it('denies receptionist and cross-clinic closure writes', async () => {
    expect((await add('http-receptionist', MONDAY)).status).toBe(403);
    expect((await add('http-other-admin', MONDAY)).status).toBe(403);
    await add('http-admin', MONDAY);
    expect((await remove('http-receptionist', MONDAY)).status).toBe(403);
    const rows = await pool.query(
      'SELECT clinic_id, closure_date::text FROM clinic_closures',
    );
    expect(rows.rows).toEqual([
      { clinic_id: ids.clinic, closure_date: MONDAY },
    ]);
  });

  it('rejects impossible or malformed days with 400', async () => {
    expect((await add('http-admin', '2026-02-29')).status).toBe(400);
    expect((await add('http-admin', 20260907)).status).toBe(400);
    expect((await remove('http-admin', '2026-13-01')).status).toBe(400);
  });
});
