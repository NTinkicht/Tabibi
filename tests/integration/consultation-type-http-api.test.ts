import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import * as typeItem from '@/app/api/clinics/[clinicId]/consultation-types/[consultationTypeId]/route';
import * as types from '@/app/api/clinics/[clinicId]/consultation-types/route';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

// TAB-P0-02 (#661): the clinic consultation-type catalogue (#651) over the
// staff HTTP boundary. Authorization stays in the service; the routes add
// origin/session checks, input validation (400, never 500) and error mapping
// (403/404/409).
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  otherAdmin: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
};
const ORIGIN = 'http://localhost';
const FOLLOW_UP = {
  code: 'follow-up',
  label: 'Follow-up',
  nominalDurationMinutes: 15,
};
type Params = Record<string, string>;
type Handler<P extends Params> = (
  request: Request,
  context: { params: Promise<P> },
) => Promise<Response>;

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'consultation-type-http-api-test-secret-at-least-32-chars';
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, consultation_types, staff_sessions,
    clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'ct-admin', 'Admin'), ($2, 'ct-other-admin', 'Other Admin'),
       ($3, 'ct-receptionist', 'Receptionist'), ($4, 'ct-doctor', 'Doctor')`,
    [ids.admin, ids.otherAdmin, ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'ct-clinic', 'Clinic'), ($2, 'ct-other-clinic', 'Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($1, $4, 'receptionist'), ($1, $5, 'doctor'),
       ($2, $6, 'clinic_admin')`,
    [
      ids.clinic,
      ids.otherClinic,
      ids.admin,
      ids.receptionist,
      ids.doctorUser,
      ids.otherAdmin,
    ],
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

function create(subject: string, body: unknown, clinicId = ids.clinic) {
  return call(
    types.POST,
    subject,
    'consultation-types',
    { clinicId },
    'POST',
    body,
  );
}

function list(subject: string, query = '', clinicId = ids.clinic) {
  return call(
    types.GET,
    subject,
    `consultation-types${query}`,
    { clinicId },
    'GET',
  );
}

function setActive(
  subject: string,
  consultationTypeId: string,
  body: unknown,
  clinicId = ids.clinic,
) {
  return call(
    typeItem.PATCH,
    subject,
    `consultation-types/${consultationTypeId}`,
    { clinicId, consultationTypeId },
    'PATCH',
    body,
  );
}

async function rows() {
  const result = await pool.query(
    `SELECT clinic_id, code, label, nominal_duration_minutes, active
       FROM consultation_types ORDER BY clinic_id, code`,
  );
  return result.rows;
}

describe('consultation type HTTP API (#661)', () => {
  it('creates, lists, retires and restores a type for the clinic admin', async () => {
    const created = await create('ct-admin', FOLLOW_UP);
    expect(created.status).toBe(201);
    expect(created.res.headers.get('cache-control')).toBe('no-store');
    const consultationType = created.json.consultationType as Record<
      string,
      unknown
    >;
    expect(consultationType).toEqual({
      id: expect.any(String),
      clinicId: ids.clinic,
      ...FOLLOW_UP,
      active: true,
    });
    const id = consultationType.id as string;

    const listed = await list('ct-admin');
    expect(listed.status).toBe(200);
    expect(listed.res.headers.get('cache-control')).toBe('no-store');
    expect(listed.json).toEqual({ consultationTypes: [consultationType] });

    const retired = await setActive('ct-admin', id, { active: false });
    expect(retired.status).toBe(200);
    expect(retired.json).toEqual({
      consultationType: { ...consultationType, active: false },
    });
    // Retired types are hidden by default and shown on request.
    expect((await list('ct-admin')).json).toEqual({ consultationTypes: [] });
    expect((await list('ct-admin', '?includeInactive=true')).json).toEqual({
      consultationTypes: [{ ...consultationType, active: false }],
    });
    expect((await list('ct-admin', '?includeInactive=false')).json).toEqual({
      consultationTypes: [],
    });

    // Setting the current state again is an idempotent 200.
    expect((await setActive('ct-admin', id, { active: false })).status).toBe(
      200,
    );
    const restored = await setActive('ct-admin', id, { active: true });
    expect(restored.status).toBe(200);
    expect(restored.json).toEqual({ consultationType });
  });

  it('maps a duplicate code in the same clinic to 409', async () => {
    expect((await create('ct-admin', FOLLOW_UP)).status).toBe(201);
    const duplicate = await create('ct-admin', {
      ...FOLLOW_UP,
      label: 'Another label',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json.error).toBe('conflict');
    expect(await rows()).toHaveLength(1);
    // The same code in another clinic is not a conflict.
    expect(
      (await create('ct-other-admin', FOLLOW_UP, ids.otherClinic)).status,
    ).toBe(201);
  });

  it('lets doctors and receptionists list but not write', async () => {
    const created = await create('ct-admin', FOLLOW_UP);
    const id = (created.json.consultationType as { id: string }).id;
    for (const subject of ['ct-doctor', 'ct-receptionist']) {
      expect((await list(subject)).status).toBe(200);
      const write = await create(subject, { ...FOLLOW_UP, code: 'new' });
      expect(write.status).toBe(403);
      expect(write.json.error).toBe('forbidden');
      const patch = await setActive(subject, id, { active: false });
      expect(patch.status).toBe(403);
    }
    expect(await rows()).toEqual([
      {
        clinic_id: ids.clinic,
        code: 'follow-up',
        label: 'Follow-up',
        nominal_duration_minutes: 15,
        active: true,
      },
    ]);
  });

  it('denies another clinic admin and hides other-clinic ids as 404', async () => {
    const created = await create('ct-admin', FOLLOW_UP);
    const id = (created.json.consultationType as { id: string }).id;
    expect((await list('ct-other-admin')).status).toBe(403);
    expect((await create('ct-other-admin', FOLLOW_UP)).status).toBe(403);
    expect(
      (await setActive('ct-other-admin', id, { active: false })).status,
    ).toBe(403);
    // Through their own clinic, the other admin cannot reach this clinic's
    // row: it is the same 404 as an unknown or malformed id.
    for (const target of [id, randomUUID(), 'not-a-uuid']) {
      const patch = await setActive(
        'ct-other-admin',
        target,
        { active: false },
        ids.otherClinic,
      );
      expect(patch.status).toBe(404);
      expect(patch.json.error).toBe('not_found');
    }
    expect((await rows())[0]).toMatchObject({ active: true });
  });

  it('rejects invalid input with 400 and writes nothing', async () => {
    const invalidBodies: unknown[] = [
      { ...FOLLOW_UP, code: 'Follow-Up' },
      { ...FOLLOW_UP, code: '-lead' },
      { ...FOLLOW_UP, code: 'x'.repeat(49) },
      { ...FOLLOW_UP, label: '   ' },
      { ...FOLLOW_UP, label: 'Bad\u0007label' },
      { ...FOLLOW_UP, label: 'x'.repeat(81) },
      { ...FOLLOW_UP, nominalDurationMinutes: 15.5 },
      { ...FOLLOW_UP, nominalDurationMinutes: 4 },
      { ...FOLLOW_UP, nominalDurationMinutes: 241 },
      { ...FOLLOW_UP, nominalDurationMinutes: '15' },
      { ...FOLLOW_UP, active: false },
      { code: 'follow-up', label: 'Follow-up' },
      null,
    ];
    for (const body of invalidBodies) {
      const response = await create('ct-admin', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.json.error).toBe('invalid_request');
    }
    expect(await rows()).toEqual([]);

    const created = await create('ct-admin', FOLLOW_UP);
    const id = (created.json.consultationType as { id: string }).id;
    for (const body of [
      { active: 'false' },
      { active: false, code: 'x' },
      {},
    ]) {
      expect((await setActive('ct-admin', id, body)).status).toBe(400);
    }
    for (const query of ['?includeInactive=1', '?includeInactive=yes']) {
      expect((await list('ct-admin', query)).status).toBe(400);
    }
    expect(
      (
        await call(
          types.GET,
          'ct-admin',
          'consultation-types',
          { clinicId: 'not-a-uuid' },
          'GET',
        )
      ).status,
    ).toBe(400);
    expect((await rows())[0]).toMatchObject({ active: true });
  });

  it('trims the label like the service does', async () => {
    const created = await create('ct-admin', {
      ...FOLLOW_UP,
      label: '  Follow-up  ',
    });
    expect(created.status).toBe(201);
    expect(created.json.consultationType).toMatchObject({ label: 'Follow-up' });
  });
});
