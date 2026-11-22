import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

// TAB-P0-01 (#767): cross-tenant denial matrix over EVERY clinic-scoped staff
// route. A newly added route under /api/clinics/[clinicId] is picked up
// automatically, so a handler that forgets the clinic scope check fails here.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ORIGIN = 'http://localhost';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Handler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const modules = import.meta.glob<Record<string, unknown>>(
  '/src/app/api/clinics/**/route.ts',
);

const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  clinicP: randomUUID(),
  adminB: randomUUID(),
  adminP: randomUUID(),
  // A real session of clinic A, so session-scoped routes reach the clinic
  // authorization instead of failing earlier on an unknown session.
  sessionA: randomUUID(),
};

// Route-specific requests that pass input validation. With a bare `{}` body
// a handler that validates first answers 400 whether or not it checks clinic
// membership, so those routes proved nothing about tenant isolation (#990).
// Each entry below is schema-valid, so the only remaining reason to refuse a
// foreign caller is the membership check itself.
type Fixture = {
  body?: unknown;
  query?: string;
  headers?: Record<string, string>;
};
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const T0 = '2026-09-07T08:00:00.000Z';
const T1 = '2026-09-07T09:00:00.000Z';
const KEY = { 'idempotency-key': 'matrix-idempotency-key-0001' };
const REASON = { reason: 'matrix reason' };
const fixtures: Record<string, Fixture> = {
  'POST clinics/[clinicId]/closures': { body: { closureDate: '2026-09-07' } },
  'PATCH clinics/[clinicId]/consultation-types/[consultationTypeId]': {
    body: { active: false },
  },
  'POST clinics/[clinicId]/consultation-types': {
    body: { code: 'matrix', label: 'Matrix', nominalDurationMinutes: 15 },
  },
  'POST clinics/[clinicId]/doctors/[doctorId]/absences': {
    body: { absenceDate: '2026-09-07' },
  },
  'PATCH clinics/[clinicId]/doctors/[doctorId]': {
    body: { specialtyCodes: ['general_medicine'] },
  },
  'POST clinics/[clinicId]/doctors': {
    body: { userId: U1, displayName: 'Matrix Doctor' },
  },
  'PATCH clinics/[clinicId]/memberships/[userId]': {
    body: { role: 'receptionist' },
  },
  'PATCH clinics/[clinicId]': { body: { name: 'Matrix clinic' } },
  'POST clinics/[clinicId]/schedule-generations': {
    body: { doctorId: U1, startDate: '2026-09-07' },
  },
  'PATCH clinics/[clinicId]/schedule-templates/[templateId]': {
    body: { active: false },
  },
  'GET clinics/[clinicId]/schedule-templates': { query: `?doctorId=${U1}` },
  'POST clinics/[clinicId]/schedule-templates': {
    body: {
      doctorId: U1,
      weekday: 1,
      localStartTime: '09:00',
      localEndTime: '12:00',
      occurrenceIndex: 0,
    },
  },
  'PATCH clinics/[clinicId]/sessions/[sessionId]/appointments/[appointmentId]':
    {
      body: { command: 'check_in' },
    },
  'POST clinics/[clinicId]/sessions/[sessionId]/appointments/bulk-no-show': {
    body: REASON,
  },
  'POST clinics/[clinicId]/sessions/[sessionId]/appointments': {
    body: { patientId: U1, scheduledStartAt: T0, scheduledEndAt: T1 },
    headers: KEY,
  },
  'POST clinics/[clinicId]/sessions/[sessionId]/commands': {
    body: { command: 'open' },
  },
  'POST clinics/[clinicId]/sessions/[sessionId]/delay': {
    body: { command: 'clear_delay', expectedVersion: 0 },
  },
  'POST clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/commands': {
    body: { command: 'check_in' },
    headers: KEY,
  },
  'POST clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/reorder': {
    body: { targetPosition: 1, expectedVersion: 0, ...REASON },
  },
  'POST clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/restore': {
    body: REASON,
  },
  'POST clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/transfer': {
    body: { ...REASON, targetSessionId: U2 },
  },
  'POST clinics/[clinicId]/sessions/[sessionId]/queue': {
    body: { privateDisplayName: 'Matrix Walkin', preferredLocale: 'fr' },
  },
  'GET clinics/[clinicId]/sessions': { query: '?date=2026-09-07' },
  'POST clinics/[clinicId]/sessions': {
    body: { doctorId: U1, serviceDate: '2026-09-07', startsAt: T0, endsAt: T1 },
    headers: KEY,
  },
  'POST clinics/[clinicId]/staff-invites': {
    body: { email: 'matrix@example.test', role: 'receptionist' },
  },
};
function fixtureKey(method: string, routePath: string): string {
  return `${method} ${routePath
    .replace('/src/app/api/', '')
    .replace('/route.ts', '')}`;
}

function paramsFor(
  routePath: string,
  clinicId: string,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [, name] of routePath.matchAll(/\[(\w+)\]/g)) {
    params[name] = /Date$/.test(name) ? '2026-09-07' : randomUUID();
  }
  params.doctorId &&= U1;
  params.sessionId &&= ids.sessionA;
  params.clinicId = clinicId;
  return params;
}

function urlFor(
  routePath: string,
  params: Record<string, string>,
  query: string,
): string {
  const rel = routePath
    .replace('/src/app', '')
    .replace('/route.ts', '')
    .replace(/\[(\w+)\]/g, (_, name: string) => params[name]);
  return `${ORIGIN}${rel}${query}`;
}

async function invoke(
  handler: Handler,
  method: string,
  routePath: string,
  cookie: string | null,
  clinicId: string = ids.clinicA,
): Promise<number> {
  const params = paramsFor(routePath, clinicId);
  const fixture = fixtures[fixtureKey(method, routePath)];
  const headers: Record<string, string> = {
    origin: ORIGIN,
    'content-type': 'application/json',
    ...KEY,
    ...fixture?.headers,
  };
  if (cookie) headers.cookie = cookie;
  const hasBody = method !== 'GET' && method !== 'DELETE';
  const res = await handler(
    new Request(urlFor(routePath, params, fixture?.query ?? ''), {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(fixture?.body ?? {}) } : {}),
    }),
    { params: Promise.resolve(params) },
  );
  return res.status;
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'cross-tenant-route-matrix-test-secret-at-least-32-chars';
  await migrate();
  await pool.query(
    `TRUNCATE audit_events, staff_sessions, clinic_memberships, clinics, users CASCADE`,
  );
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, 'matrix-admin-b', 'Admin B')`,
    [ids.adminB],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'matrix-a', 'A'), ($2, 'matrix-b', 'B'), ($3, 'matrix-p', 'P')`,
    [ids.clinicA, ids.clinicB, ids.clinicP],
  );
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, 'matrix-admin-p', 'Admin P')`,
    [ids.adminP],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES ($1, $2, 'clinic_admin')`,
    [ids.clinicP, ids.adminP],
  );
  // The fixture doctor U1 exists only in clinic P, so a member of P is not
  // refused as "unknown doctor" while a foreign caller still is.
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, 'matrix-doctor-p', 'Doctor P')`,
    [U1],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES ($1, $2, 'doctor')`,
    [ids.clinicP, U1],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $1, 'Doctor P')`,
    [U1],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2), ($3, $2)`,
    [ids.clinicP, U1, ids.clinicA],
  );
  await pool.query(
    `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,'2026-09-07','2026-09-07T08:00:00Z','2026-09-07T11:00:00Z','open')`,
    [ids.sessionA, ids.clinicA, U1],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES ($1, $2, 'clinic_admin')`,
    [ids.clinicB, ids.adminB],
  );
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

const sources = import.meta.glob<string>('/src/app/api/clinics/**/route.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

// Scope: this matrix proves the HTTP layer never succeeds or mutates for a
// foreign or anonymous caller and that every handler authenticates the staff
// session before parsing input. Service-level role checks with route-specific
// valid payloads against seeded clinic-A resources are tracked separately.
const routePaths = Object.keys(modules).sort();

describe('cross-tenant denial matrix over clinic-scoped routes', () => {
  it('authenticates the clinic scope before reading any request body', () => {
    for (const [path, src] of Object.entries(sources)) {
      const auth = src.indexOf('authenticatedClinicScope(');
      expect(
        auth,
        `${path} must call authenticatedClinicScope`,
      ).toBeGreaterThan(-1);
      const body = src.indexOf('request.json()');
      if (body !== -1) {
        expect(
          auth,
          `${path} reads the body before authenticating`,
        ).toBeLessThan(body);
      }
    }
  });

  it('discovers the clinic-scoped route inventory', () => {
    expect(routePaths.length).toBeGreaterThanOrEqual(28);
  });

  for (const routePath of routePaths) {
    it(`denies cross-clinic and anonymous access on ${routePath}`, async () => {
      const mod = await modules[routePath]();
      const exported = METHODS.filter((m) => typeof mod[m] === 'function');
      expect(exported.length).toBeGreaterThan(0);
      const cookie = `tabibi_staff_session=${await createStaffSessionToken(
        'matrix-admin-b',
        new Date(Date.now() + 60_000),
      )}`;
      for (const method of exported) {
        const handler = mod[method] as Handler;
        const cross = await invoke(handler, method, routePath, cookie);
        // Every request is schema-valid, so a foreign caller can only be
        // refused by the clinic membership check: exactly 403, never 400.
        expect(cross, `${method} ${routePath} cross-clinic`).toBe(403);
        const anon = await invoke(handler, method, routePath, null);
        expect(anon, `${method} ${routePath} anonymous`).toBe(401);
      }
    });
  }

  // Positive control: the same requests from a real clinic_admin of the
  // addressed clinic are not refused as invalid or forbidden. Without this a
  // payload that the route rejects with 400 would let the exact-403 assertion
  // above pass for the wrong reason.
  for (const routePath of routePaths) {
    it(`accepts the fixture requests of a member on ${routePath}`, async () => {
      const mod = await modules[routePath]();
      const cookie = `tabibi_staff_session=${await createStaffSessionToken(
        'matrix-admin-p',
        new Date(Date.now() + 60_000),
      )}`;
      for (const method of METHODS.filter(
        (m) => typeof mod[m] === 'function',
      )) {
        if (!fixtures[fixtureKey(method, routePath)]) continue;
        const status = await invoke(
          mod[method] as Handler,
          method,
          routePath,
          cookie,
          ids.clinicP,
        );
        expect(
          [400, 401, 403].includes(status) || status >= 500,
          `${method} ${routePath} member returned ${status}`,
        ).toBe(false);
      }
    });
  }

  it('only declares fixtures for discovered route methods', async () => {
    for (const key of Object.keys(fixtures)) {
      const [method, ...rest] = key.split(' ');
      const path = `/src/app/api/${rest.join(' ')}/route.ts`;
      expect(routePaths, key).toContain(path);
      const mod = await modules[path]();
      expect(typeof mod[method], key).toBe('function');
    }
  });

  it('left clinic A without any audit event or membership change', async () => {
    const audit = await pool.query(
      'SELECT count(*)::int AS n FROM audit_events WHERE clinic_id = $1',
      [ids.clinicA],
    );
    expect(audit.rows[0].n).toBe(0);
    const members = await pool.query(
      'SELECT count(*)::int AS n FROM clinic_memberships WHERE clinic_id = $1',
      [ids.clinicA],
    );
    expect(members.rows[0].n).toBe(0);
  });
});
