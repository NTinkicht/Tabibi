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
  adminB: randomUUID(),
};

function paramsFor(routePath: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [, name] of routePath.matchAll(/\[(\w+)\]/g)) {
    params[name] = /Date$/.test(name) ? '2026-09-07' : randomUUID();
  }
  params.clinicId = ids.clinicA;
  return params;
}

function urlFor(routePath: string, params: Record<string, string>): string {
  const rel = routePath
    .replace('/src/app', '')
    .replace('/route.ts', '')
    .replace(/\[(\w+)\]/g, (_, name: string) => params[name]);
  return `${ORIGIN}${rel}`;
}

async function invoke(
  handler: Handler,
  method: string,
  routePath: string,
  cookie: string | null,
): Promise<number> {
  const params = paramsFor(routePath);
  const headers: Record<string, string> = {
    origin: ORIGIN,
    'content-type': 'application/json',
  };
  if (cookie) headers.cookie = cookie;
  const hasBody = method !== 'GET' && method !== 'DELETE';
  const res = await handler(
    new Request(urlFor(routePath, params), {
      method,
      headers,
      ...(hasBody ? { body: '{}' } : {}),
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
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'matrix-a', 'A'), ($2, 'matrix-b', 'B')`,
    [ids.clinicA, ids.clinicB],
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

describe('cross-tenant denial matrix over clinic-scoped routes', () => {
  const routePaths = Object.keys(modules).sort();

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
        // Validation (400) may run before the service-level authorization, so
        // the contract is: never success, never a server error, no mutation.
        expect(
          cross >= 400 && cross < 500,
          `${method} ${routePath} cross-clinic returned ${cross}`,
        ).toBe(true);
        const anon = await invoke(handler, method, routePath, null);
        expect(anon, `${method} ${routePath} anonymous`).toBe(401);
      }
    });
  }

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
