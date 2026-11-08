import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';
import {
  GET as listInvites,
  POST as createInvite,
} from '@/app/api/clinics/[clinicId]/staff-invites/route';
import { DELETE as revokeInvite } from '@/app/api/clinics/[clinicId]/staff-invites/[inviteId]/route';
import { GET as listSessions } from '@/app/api/clinics/[clinicId]/sessions/route';
import { DELETE as removeMember } from '@/app/api/clinics/[clinicId]/memberships/[userId]/route';
import { GET as discovery } from '@/app/api/public/discovery/route';
import { POST as previewInvite } from '@/app/api/staff/invites/preview/route';
import { POST as acceptInvite } from '@/app/api/staff/invites/accept/route';

// Gap register G-18 (TAB-P1-07, #824): the HTTP surface of staff invites.
// clinic_admin-only create / list / revoke; a public, same-origin preview and
// accept that redeem a single-use token; the token appears only in the create
// response and never in a URL, list, audit row or error body.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ORIGIN = 'http://localhost';
const GOOD = 'correct horse battery';
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  adminA: randomUUID(),
  receptionistA: randomUUID(),
  adminB: randomUUID(),
};
const subjects = {
  adminA: 'inv-admin-a@x.example',
  receptionistA: 'inv-rec-a@x.example',
  adminB: 'inv-admin-b@x.example',
};

async function cookie(subject: string): Promise<string> {
  const token = await createStaffSessionToken(
    subject,
    new Date(Date.now() + 60_000),
  );
  return `tabibi_staff_session=${token}`;
}

async function create(
  actor: string,
  body: unknown,
  clinicId = ids.clinicA,
): Promise<Response> {
  return createInvite(
    new Request(`${ORIGIN}/api/clinics/${clinicId}/staff-invites`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        cookie: await cookie(actor),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ clinicId }) },
  );
}

async function list(actor: string, clinicId = ids.clinicA): Promise<Response> {
  return listInvites(
    new Request(`${ORIGIN}/api/clinics/${clinicId}/staff-invites`, {
      headers: { cookie: await cookie(actor) },
    }),
    { params: Promise.resolve({ clinicId }) },
  );
}

async function revoke(
  actor: string,
  inviteId: string,
  clinicId = ids.clinicA,
): Promise<number> {
  const response = await revokeInvite(
    new Request(`${ORIGIN}/api/clinics/${clinicId}/staff-invites/${inviteId}`, {
      method: 'DELETE',
      headers: { origin: ORIGIN, cookie: await cookie(actor) },
    }),
    { params: Promise.resolve({ clinicId, inviteId }) },
  );
  return response.status;
}

function publicPost(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  origin: string | undefined = ORIGIN,
): Promise<Response> {
  return handler(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

const preview = (token: string, origin?: string) =>
  publicPost(previewInvite, '/api/staff/invites/preview', { token }, origin);
const accept = (token: string, password = GOOD, displayName = 'New Staff') =>
  publicPost(acceptInvite, '/api/staff/invites/accept', {
    token,
    displayName,
    password,
  });

async function newInvite(
  email: string,
  role: 'doctor' | 'receptionist' = 'receptionist',
): Promise<{ inviteId: string; token: string }> {
  const response = await create(subjects.adminA, { email, role });
  expect(response.status).toBe(201);
  return (
    (await response.json()) as { invite: { inviteId: string; token: string } }
  ).invite;
}

async function sessionsStatus(subject: string): Promise<number> {
  const response = await listSessions(
    new Request(
      `${ORIGIN}/api/clinics/${ids.clinicA}/sessions?date=2026-11-10`,
      { headers: { cookie: await cookie(subject) } },
    ),
    { params: Promise.resolve({ clinicId: ids.clinicA }) },
  );
  return response.status;
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'staff-invite-http-api-secret-at-least-32-characters';
  await migrate();
});

beforeEach(async () => {
  await pool.query(
    `TRUNCATE audit_events, staff_sessions, staff_sign_in_rate_limit_buckets,
       staff_invites, staff_credentials, consultation_sessions, clinic_memberships,
       doctor_clinics, doctor_profiles, clinics, users CASCADE`,
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'inv-a', 'Invite Clinic A'), ($2, 'inv-b', 'Invite Clinic B')`,
    [ids.clinicA, ids.clinicB],
  );
  for (const [key, clinic, role] of [
    ['adminA', ids.clinicA, 'clinic_admin'],
    ['receptionistA', ids.clinicA, 'receptionist'],
    ['adminB', ids.clinicB, 'clinic_admin'],
  ] as const) {
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $2)`,
      [ids[key], subjects[key]],
    );
    await pool.query(
      `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES ($1, $2, $3)`,
      [clinic, ids[key], role],
    );
  }
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('staff invite HTTP API (G-18)', () => {
  it('only a clinic_admin of the clinic can create, list or revoke', async () => {
    const { inviteId } = await newInvite('first@x.example');
    const body = { email: 'other@x.example', role: 'receptionist' };
    expect((await create(subjects.receptionistA, body)).status).toBe(403);
    expect((await create(subjects.adminB, body)).status).toBe(403);
    expect((await list(subjects.receptionistA)).status).toBe(403);
    expect((await list(subjects.adminB)).status).toBe(403);
    expect(await revoke(subjects.receptionistA, inviteId)).toBe(403);
    expect(await revoke(subjects.adminB, inviteId)).toBe(403);
    // Through clinic B's own path the invite does not exist.
    expect(await revoke(subjects.adminB, inviteId, ids.clinicB)).toBe(404);
    expect(await revoke(subjects.adminA, 'not-a-uuid')).toBe(404);
    expect(await revoke(subjects.adminA, randomUUID())).toBe(404);
    const open = await pool.query(
      `SELECT 1 FROM staff_invites WHERE revoked_at IS NULL`,
    );
    expect(open.rowCount).toBe(1);
  });

  it('creates once with a no-store token, refuses duplicates and bad input, and lists without secrets', async () => {
    const response = await create(subjects.adminA, {
      email: ' Doc@X.example ',
      role: 'doctor',
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { invite } = (await response.json()) as {
      invite: { inviteId: string; token: string; expiresAt: string };
    };
    expect(invite.token.startsWith(`${invite.inviteId}.`)).toBe(true);

    expect(
      (
        await create(subjects.adminA, {
          email: 'doc@x.example',
          role: 'doctor',
        })
      ).status,
    ).toBe(409);
    for (const bad of [
      { email: 'x@x.example', role: 'clinic_admin' },
      { email: 'not-an-email', role: 'receptionist' },
      { email: 'x@x.example', role: 'receptionist', ttlSeconds: 30 },
      { email: 'x@x.example', role: 'receptionist', extra: true },
    ])
      expect((await create(subjects.adminA, bad)).status).toBe(400);

    const listed = await list(subjects.adminA);
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(text).not.toContain(invite.token.split('.')[1]!);
    expect(JSON.parse(text)).toEqual({
      invites: [
        {
          inviteId: invite.inviteId,
          email: 'doc@x.example',
          role: 'doctor',
          status: 'pending',
          createdAt: expect.any(String),
          expiresAt: invite.expiresAt,
        },
      ],
    });
  });

  it('previews and accepts once; the new member can work on the next request', async () => {
    const { token, inviteId } = await newInvite('joiner@x.example');
    expect((await preview(token, 'https://attacker.example')).status).toBe(403);
    const shown = await preview(token);
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual({
      invite: {
        clinicName: 'Invite Clinic A',
        email: 'joiner@x.example',
        role: 'receptionist',
        expiresAt: expect.any(String),
      },
    });

    const weak = await accept(token, 'short');
    expect(weak.status).toBe(400);
    expect(await weak.json()).toEqual({
      error: 'password_policy',
      code: 'too_short',
    });
    const identity = await accept(token, 'joiner');
    expect(identity.status).toBe(400);
    // A rejected attempt leaves the invite open.
    expect((await preview(token)).status).toBe(200);

    const accepted = await accept(token);
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.text();
    expect(acceptedBody).not.toContain(token.split('.')[1]!);
    expect(JSON.parse(acceptedBody)).toEqual({
      accepted: { clinicId: ids.clinicA, role: 'receptionist' },
    });
    expect(await sessionsStatus('joiner@x.example')).toBe(200);

    for (const response of [await accept(token), await preview(token)]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invite_invalid' });
    }
    expect(await revoke(subjects.adminA, inviteId)).toBe(404);
    const listed = (await (await list(subjects.adminA)).json()) as {
      invites: unknown[];
    };
    expect(listed.invites).toEqual([]);
  });

  it('a concurrent double accept has exactly one winner', async () => {
    const { token } = await newInvite('race@x.example');
    const statuses = (
      await Promise.all([accept(token), accept(token), accept(token)])
    ).map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(2);
    const members = await pool.query(
      `SELECT 1 FROM clinic_memberships membership
         JOIN users ON users.id = membership.user_id
        WHERE users.auth_subject = 'race@x.example'`,
    );
    expect(members.rowCount).toBe(1);
  });

  it('revoked, expired, malformed and wrong-secret tokens get one generic answer', async () => {
    const revoked = await newInvite('revoked@x.example');
    expect(await revoke(subjects.adminA, revoked.inviteId)).toBe(200);
    expect(await revoke(subjects.adminA, revoked.inviteId)).toBe(404);

    const expired = await newInvite('expired@x.example');
    await pool.query(
      `UPDATE staff_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [expired.inviteId],
    );
    const listed = (await (await list(subjects.adminA)).json()) as {
      invites: { inviteId: string; status: string }[];
    };
    expect(listed.invites).toEqual([
      expect.objectContaining({
        inviteId: expired.inviteId,
        status: 'expired',
      }),
    ]);

    const live = await newInvite('live@x.example');
    const wrongSecret = `${live.inviteId}.${'A'.repeat(43)}`;
    for (const token of [
      revoked.token,
      expired.token,
      wrongSecret,
      'garbage',
      `${randomUUID()}.${'B'.repeat(43)}`,
    ]) {
      for (const response of [await preview(token), await accept(token)]) {
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invite_invalid' });
      }
    }
    // Malformed bodies are one generic 400 that echoes nothing.
    const malformed = await publicPost(
      acceptInvite,
      '/api/staff/invites/accept',
      { token: live.token, displayName: 'X', password: GOOD, admin: true },
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain(GOOD);
    // The live invite is still usable after all of that.
    expect((await preview(live.token)).status).toBe(200);
  });

  it('caps guessing on one invite id', async () => {
    const { inviteId, token } = await newInvite('limited@x.example');
    const wrong = `${inviteId}.${'C'.repeat(43)}`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1)
      statuses.push((await preview(wrong)).status);
    expect(statuses.slice(0, 20).every((status) => status === 400)).toBe(true);
    const limited = await preview(token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('900');
  });

  it('audits create, revoke and accept with ids and roles only', async () => {
    const kept = await newInvite('audit-a@x.example', 'doctor');
    const dropped = await newInvite('audit-b@x.example');
    expect(await revoke(subjects.adminA, dropped.inviteId)).toBe(200);
    expect((await accept(kept.token, GOOD, 'Dr Audit')).status).toBe(200);
    const rows = await pool.query<{ action: string; metadata: unknown }>(
      `SELECT action, metadata FROM audit_events
        WHERE entity_type = 'staff_invite' ORDER BY id`,
    );
    expect(rows.rows.map((row) => row.action)).toEqual([
      'invite_created',
      'invite_created',
      'invite_revoked',
      'invite_accepted',
    ]);
    const serialized = JSON.stringify(rows.rows);
    for (const secret of [kept.token, dropped.token].map(
      (token) => token.split('.')[1]!,
    ))
      expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(GOOD);
  });

  it('a removed doctor invited back is listed publicly again', async () => {
    const first = await newInvite('returning@x.example', 'doctor');
    expect((await accept(first.token, GOOD, 'Dr Returning')).status).toBe(200);
    const doctorNames = async () =>
      (
        (await (
          await discovery(new Request(`${ORIGIN}/api/public/discovery`))
        ).json()) as { clinics: { doctors: { displayName: string }[] }[] }
      ).clinics.flatMap((clinic) =>
        clinic.doctors.map((doctor) => doctor.displayName),
      );
    expect(await doctorNames()).toContain('Dr Returning');

    const user = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE auth_subject = 'returning@x.example'`,
    );
    const userId = user.rows[0]!.id;
    const removed = await removeMember(
      new Request(
        `${ORIGIN}/api/clinics/${ids.clinicA}/memberships/${userId}`,
        {
          method: 'DELETE',
          headers: { origin: ORIGIN, cookie: await cookie(subjects.adminA) },
        },
      ),
      { params: Promise.resolve({ clinicId: ids.clinicA, userId }) },
    );
    expect(removed.status).toBe(200);
    expect(await doctorNames()).not.toContain('Dr Returning');

    const again = await newInvite('returning@x.example', 'doctor');
    expect((await accept(again.token, 'another long password')).status).toBe(
      200,
    );
    expect(await doctorNames()).toContain('Dr Returning');
  });
});
