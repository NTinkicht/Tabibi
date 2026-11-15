import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../scripts/db/lib';
import { GET as sessionsGet } from '@/app/api/clinics/[clinicId]/sessions/route';
import {
  GET as meGet,
  POST as signInPost,
} from '@/app/api/patient/session/route';
import { POST as logoutPost } from '@/app/api/patient/session/logout/route';
import { registerPatientAccount } from '@/modules/identity/patient-credentials';
import { closePool, getPool } from '@/platform/database/pool';
import { createPatientSessionToken } from '@/platform/http/patient-auth';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

// TAB-P1-01 slice 2: patient sign-in, current account, logout.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const SECRET = 'patient-session-secret-at-least-32-characters';
const EMAIL = 'amina.patient@example.test';
const GOOD = 'correct horse battery';
const PCOOKIE = 'tabibi_patient_session';
const STAFF = 'patient-session-staff@example.test';
const clinic = randomUUID();
let patientId = '';

function signIn(
  body: unknown,
  extra: Record<string, string> = {},
  origin: string | null = 'http://localhost',
) {
  const headers = new Headers({ 'content-type': 'application/json', ...extra });
  if (origin !== null) headers.set('origin', origin);
  return signInPost(
    new Request('http://localhost/api/patient/session', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}
const good = (extra: Record<string, string> = {}) =>
  signIn({ email: EMAIL, password: GOOD }, extra);
const tokenOf = (res: Response) =>
  /tabibi_patient_session=([^;]+)/.exec(
    res.headers.get('set-cookie') ?? '',
  )?.[1];
const me = (cookie?: string) =>
  meGet(
    new Request('http://localhost/api/patient/session', {
      headers: cookie ? { cookie } : {},
    }),
  );
const logout = (cookie?: string) =>
  logoutPost(
    new Request('http://localhost/api/patient/session/logout', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        ...(cookie ? { cookie } : {}),
      },
    }),
  );

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET = SECRET;
  await migrate();
});
beforeEach(async () => {
  delete process.env.PATIENT_SESSION_TTL_SECONDS;
  await pool.query(
    `TRUNCATE patient_credentials, clinic_memberships, clinics, users,
       staff_sign_in_rate_limit_buckets CASCADE`,
  );
  const registered = await registerPatientAccount(getPool(), {
    email: EMAIL,
    displayName: 'Amina',
    password: GOOD,
  });
  if (!registered.ok) throw new Error('setup failed');
  patientId = registered.userId;
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES(gen_random_uuid(),$1,'Staff')`,
    [STAFF],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'patient-session-clinic','Clinic')`,
    [clinic],
  );
});
afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('POST /api/patient/session', () => {
  it('signs in, sets a hardened cookie and the cookie reads the account', async () => {
    const res = await good();
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(await res.json()).toEqual({ account: { displayName: 'Amina' } });
    const who = await me(`${PCOOKIE}=${tokenOf(res)}`);
    expect(who.status).toBe(200);
    expect(await who.json()).toEqual({ account: { displayName: 'Amina' } });
    const stored = await pool.query(
      'SELECT user_id FROM patient_sessions WHERE revoked_at IS NULL',
    );
    expect(stored.rows).toEqual([{ user_id: patientId }]);
  });

  it('answers unknown account, wrong password and malformed email with one 401', async () => {
    const bodies = [
      { email: 'nobody@example.test', password: GOOD },
      { email: EMAIL, password: 'wrong password here' },
      { email: 'not-an-email', password: GOOD },
    ];
    const seen: string[] = [];
    for (const body of bodies) {
      const res = await signIn(body);
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
      seen.push(((await res.json()) as { error: unknown }).error as string);
    }
    expect(new Set(seen).size).toBe(1);
  });

  it('rejects missing or foreign origin, unknown keys and oversize bodies without echo', async () => {
    expect(
      (await signIn({ email: EMAIL, password: GOOD }, {}, null)).status,
    ).toBe(403);
    expect(
      (await signIn({ email: EMAIL, password: GOOD }, {}, 'http://evil.test'))
        .status,
    ).toBe(403);
    const extra = await signIn({ email: EMAIL, password: GOOD, role: 'admin' });
    expect(extra.status).toBe(400);
    expect(JSON.stringify(await extra.json())).not.toContain(GOOD);
    const huge = await signIn(
      JSON.stringify({ email: EMAIL, password: 'x'.repeat(9000) }),
    );
    expect(huge.status).toBe(400);
  });

  it('rate limits repeated attempts per account with Retry-After', async () => {
    for (let i = 0; i < 10; i += 1)
      expect(
        (await signIn({ email: EMAIL, password: 'bad-password-1' })).status,
      ).toBe(401);
    const limited = await good();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('900');
    expect(limited.headers.get('set-cookie')).toBeNull();
  });

  it('a new sign-in revokes the session carried by the request', async () => {
    const first = tokenOf(await good());
    const second = await good({ cookie: `${PCOOKIE}=${first}` });
    expect(second.status).toBe(200);
    expect((await me(`${PCOOKIE}=${first}`)).status).toBe(401);
    expect((await me(`${PCOOKIE}=${tokenOf(second)}`)).status).toBe(200);
  });
});

describe('patient session verification', () => {
  it('logout revokes server-side, is idempotent and clears the cookie', async () => {
    const cookie = `${PCOOKIE}=${tokenOf(await good())}`;
    const out = await logout(cookie);
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await me(cookie)).status).toBe(401);
    expect((await logout(cookie)).status).toBe(200);
    expect((await logout()).status).toBe(200);
    const noOrigin = await logoutPost(
      new Request('http://localhost/api/patient/session/logout', {
        method: 'POST',
      }),
    );
    expect(noOrigin.status).toBe(403);
  });

  it('rejects missing, tampered, duplicated, expired and revoked-by-row sessions', async () => {
    const token = tokenOf(await good()) as string;
    expect((await me()).status).toBe(401);
    expect((await me(`${PCOOKIE}=${token}x`)).status).toBe(401);
    expect((await me(`${PCOOKIE}=${token}; ${PCOOKIE}=${token}`)).status).toBe(
      401,
    );
    expect((await me(`${PCOOKIE}=${token}.extra`)).status).toBe(401);
    await pool.query(
      `UPDATE patient_sessions SET issued_at = now() - interval '2 hours',
         expires_at = now() - interval '1 hour'`,
    );
    expect((await me(`${PCOOKIE}=${token}`)).status).toBe(401);
  });

  it('keeps patient and staff sessions non-interchangeable, with positive controls', async () => {
    const patientToken = tokenOf(await good()) as string;
    expect((await me(`${PCOOKIE}=${patientToken}`)).status).toBe(200);
    const staffToken = await createStaffSessionToken(
      STAFF,
      new Date(Date.now() + 3600_000),
    );
    // Positive control: the staff token is a valid staff session.
    const asStaff = await sessionsGet(
      new Request(
        `http://localhost/api/clinics/${clinic}/sessions?date=2026-10-24`,
        { headers: { cookie: `tabibi_staff_session=${staffToken}` } },
      ),
      { params: Promise.resolve({ clinicId: clinic }) },
    );
    expect(asStaff.status).not.toBe(401);
    // A staff token presented as a patient cookie, and the patient token
    // presented as a staff cookie, are both refused.
    expect((await me(`${PCOOKIE}=${staffToken}`)).status).toBe(401);
    const patientAsStaff = await sessionsGet(
      new Request(
        `http://localhost/api/clinics/${clinic}/sessions?date=2026-10-24`,
        { headers: { cookie: `tabibi_staff_session=${patientToken}` } },
      ),
      { params: Promise.resolve({ clinicId: clinic }) },
    );
    expect(patientAsStaff.status).toBe(401);
  });

  it('refuses to mint a session for a user without patient credentials', async () => {
    await expect(
      createPatientSessionToken(randomUUID(), new Date(Date.now() + 60_000)),
    ).rejects.toThrow();
    const staffUser = await pool.query<{ id: string }>(
      'SELECT id FROM users WHERE auth_subject = $1',
      [STAFF],
    );
    await expect(
      createPatientSessionToken(
        staffUser.rows[0]!.id,
        new Date(Date.now() + 60_000),
      ),
    ).rejects.toThrow();
  });
});
