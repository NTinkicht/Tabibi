import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import * as doctors from '@/app/api/clinics/[clinicId]/doctors/route';
import * as memberItem from '@/app/api/clinics/[clinicId]/memberships/[userId]/route';
import * as members from '@/app/api/clinics/[clinicId]/memberships/route';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

// TAB-P0-02 (#663): staff assignments (#653 integrity rules) and the clinic
// doctor list over the staff HTTP boundary. Authorization stays in
// ClinicService; the routes add origin/session checks, input validation and
// error mapping (403/404/409). A role change never adds a new member.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  otherAdmin: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  outsider: randomUUID(),
};
const ORIGIN = 'http://localhost';
type Params = Record<string, string>;
type Handler<P extends Params> = (
  request: Request,
  context: { params: Promise<P> },
) => Promise<Response>;

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'staff-membership-http-api-test-secret-at-least-32-chars';
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, staff_sessions, doctor_clinics,
    doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'sm-admin', 'Admin'), ($2, 'sm-other-admin', 'Other Admin'),
       ($3, 'sm-receptionist', 'Receptionist'), ($4, 'sm-doctor', 'Doctor'),
       ($5, 'sm-outsider', 'Outsider')`,
    [ids.admin, ids.otherAdmin, ids.receptionist, ids.doctorUser, ids.outsider],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'sm-clinic', 'Clinic'), ($2, 'sm-other-clinic', 'Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name)
     VALUES ($1, $2, 'Dr Amina')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    'INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)',
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($1, $4, 'receptionist'), ($1, $5, 'doctor'),
       ($2, $6, 'clinic_admin'), ($2, $7, 'receptionist')`,
    [
      ids.clinic,
      ids.otherClinic,
      ids.admin,
      ids.receptionist,
      ids.doctorUser,
      ids.otherAdmin,
      ids.outsider,
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
  body?: string,
): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
  const cookie = `tabibi_staff_session=${await createStaffSessionToken(
    subject,
    new Date(Date.now() + 60_000),
  )}`;
  const res = await handler(
    new Request(`${ORIGIN}/api/clinics/${params.clinicId}/${path}`, {
      method,
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    }),
    { params: Promise.resolve(params) },
  );
  return { status: res.status, json: await res.json(), res };
}

function listMembers(subject: string, clinicId = ids.clinic) {
  return call(members.GET, subject, 'memberships', { clinicId }, 'GET');
}

function listDoctors(subject: string, clinicId = ids.clinic) {
  return call(doctors.GET, subject, 'doctors', { clinicId }, 'GET');
}

function setRole(
  subject: string,
  userId: string,
  body: unknown,
  clinicId = ids.clinic,
) {
  return call(
    memberItem.PATCH,
    subject,
    `memberships/${userId}`,
    { clinicId, userId },
    'PATCH',
    typeof body === 'string' ? body : JSON.stringify(body),
  );
}

async function memberships() {
  const result = await pool.query(
    `SELECT clinic_id, user_id, role FROM clinic_memberships
      ORDER BY clinic_id, user_id`,
  );
  return result.rows;
}

async function membershipAudits(): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM audit_events WHERE action = 'membership.set'`,
  );
  return result.rows[0].n;
}

describe('staff membership HTTP API (#663)', () => {
  it('lists memberships and doctors for the clinic admin', async () => {
    const listed = await listMembers('sm-admin');
    expect(listed.status).toBe(200);
    expect(listed.res.headers.get('cache-control')).toBe('no-store');
    expect(listed.json).toEqual({
      memberships: [
        { userId: ids.admin, role: 'clinic_admin' },
        { userId: ids.receptionist, role: 'receptionist' },
        { userId: ids.doctorUser, role: 'doctor' },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    });
    const docs = await listDoctors('sm-admin');
    expect(docs.status).toBe(200);
    expect(docs.res.headers.get('cache-control')).toBe('no-store');
    expect(docs.json).toEqual({
      doctors: [
        {
          id: ids.doctor,
          userId: ids.doctorUser,
          displayName: 'Dr Amina',
          specialtyCodes: [],
        },
      ],
    });
  });

  it('promotes and demotes an existing member with one audit per change', async () => {
    const promoted = await setRole('sm-admin', ids.receptionist, {
      role: 'clinic_admin',
    });
    expect(promoted.status).toBe(200);
    expect(promoted.res.headers.get('cache-control')).toBe('no-store');
    expect(promoted.json).toEqual({
      membership: { userId: ids.receptionist, role: 'clinic_admin' },
    });
    expect(await membershipAudits()).toBe(1);
    const same = await setRole('sm-admin', ids.receptionist, {
      role: 'clinic_admin',
    });
    expect(same.status).toBe(200);
    expect(await membershipAudits()).toBe(1);
    const demoted = await setRole('sm-receptionist', ids.admin, {
      role: 'receptionist',
    });
    expect(demoted.status).toBe(200);
    expect(await membershipAudits()).toBe(2);
    expect((await listMembers('sm-receptionist')).json).toMatchObject({
      memberships: expect.arrayContaining([
        { userId: ids.admin, role: 'receptionist' },
        { userId: ids.receptionist, role: 'clinic_admin' },
      ]),
    });
  });

  it('maps the integrity rules to 409 and leaves the rows unchanged', async () => {
    const before = await memberships();
    const lastAdmin = await setRole('sm-admin', ids.admin, {
      role: 'receptionist',
    });
    expect(lastAdmin.status).toBe(409);
    expect(lastAdmin.json).toMatchObject({ error: 'conflict' });
    const noAssociation = await setRole('sm-admin', ids.receptionist, {
      role: 'doctor',
    });
    expect(noAssociation.status).toBe(409);
    expect(noAssociation.json).toMatchObject({ error: 'conflict' });
    expect(await memberships()).toEqual(before);
    expect(await membershipAudits()).toBe(0);
  });

  it('allows the doctor role only for a member associated as this clinic doctor', async () => {
    // The association rule is checked on the requested role, not the
    // current one: the associated doctor can return to doctor, while a
    // former doctor whose association is gone cannot.
    expect(
      (await setRole('sm-admin', ids.doctorUser, { role: 'receptionist' }))
        .status,
    ).toBe(200);
    const back = await setRole('sm-admin', ids.doctorUser, { role: 'doctor' });
    expect(back.status).toBe(200);
    expect(back.json).toEqual({
      membership: { userId: ids.doctorUser, role: 'doctor' },
    });
    await setRole('sm-admin', ids.doctorUser, { role: 'receptionist' });
    await pool.query('DELETE FROM doctor_clinics WHERE clinic_id = $1', [
      ids.clinic,
    ]);
    const before = await memberships();
    const unassociated = await setRole('sm-admin', ids.doctorUser, {
      role: 'doctor',
    });
    expect(unassociated.status).toBe(409);
    expect(unassociated.json).toMatchObject({ error: 'conflict' });
    expect(await memberships()).toEqual(before);
    expect(await membershipAudits()).toBe(3);
  });

  it('never adds a member: non-member, unknown and malformed users are the same 404', async () => {
    const before = await memberships();
    for (const userId of [ids.outsider, ids.otherAdmin, randomUUID(), 'nope']) {
      const response = await setRole('sm-admin', userId, {
        role: 'receptionist',
      });
      expect(response.status).toBe(404);
      expect(response.json).toMatchObject({
        error: 'not_found',
        message: 'Membership not found',
      });
    }
    expect(await memberships()).toEqual(before);
    expect(await membershipAudits()).toBe(0);
  });

  it('denies non-admin staff and other clinics', async () => {
    const before = await memberships();
    for (const subject of ['sm-receptionist', 'sm-doctor']) {
      expect((await listMembers(subject)).status).toBe(403);
      const write = await setRole(subject, ids.receptionist, {
        role: 'clinic_admin',
      });
      expect(write.status).toBe(403);
      expect(write.json).toMatchObject({ error: 'forbidden' });
      expect(
        (await setRole(subject, randomUUID(), { role: 'doctor' })).status,
      ).toBe(403);
      expect((await listDoctors(subject)).status).toBe(200);
    }
    expect((await listMembers('sm-other-admin')).status).toBe(403);
    expect((await listDoctors('sm-other-admin')).status).toBe(403);
    expect(
      (await setRole('sm-other-admin', ids.receptionist, { role: 'doctor' }))
        .status,
    ).toBe(403);
    expect(await memberships()).toEqual(before);
  });

  it('rejects invalid bodies with 400 and writes nothing', async () => {
    const before = await memberships();
    for (const body of [
      { role: 'platform_admin' },
      { role: 'clinic_admin', userId: ids.outsider },
      {},
      { role: null },
      'not json',
    ]) {
      const response = await setRole('sm-admin', ids.receptionist, body);
      expect(response.status).toBe(400);
      expect(response.json).toMatchObject({ error: 'invalid_request' });
    }
    expect(await memberships()).toEqual(before);
    expect(await membershipAudits()).toBe(0);
  });
});
