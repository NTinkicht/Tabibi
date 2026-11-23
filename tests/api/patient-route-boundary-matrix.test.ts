import { createHmac } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPatientSessionToken } from '@/platform/http/patient-auth';

// TAB-P1-01 (#1013): every account-owned patient route must refuse an
// unauthenticated caller, a staff-signed token and a cross-site mutation at
// the HTTP boundary. The pool is a recording fake that answers only the
// session lookup, so a route that reaches any other statement, or opens a
// transaction, fails on the recorded access and not only on the status.
type Access = { sessionLookups: number; other: string[]; connects: number };
const access = vi.hoisted(
  (): { value: Access; sessionRows: Record<string, unknown>[] } => ({
    value: { sessionLookups: 0, other: [], connects: 0 },
    sessionRows: [],
  }),
);
vi.mock('@/platform/database/pool', () => ({
  getPool: () => ({
    query: async (sql: string) => {
      if (sql.includes('FROM patient_sessions')) {
        access.value.sessionLookups += 1;
        return { rows: access.sessionRows };
      }
      access.value.other.push(sql.trim().slice(0, 40));
      throw new Error('patient route boundary test must not run this query');
    },
    connect: async () => {
      access.value.connects += 1;
      throw new Error('patient route boundary test must not open a client');
    },
  }),
}));

const SECRET = 'patient-route-boundary-matrix-secret-0123456789';
const COOKIE = 'tabibi_patient_session';
const USER = '99999999-9999-4999-8999-999999999999';
const ids = {
  dependentId: '11111111-1111-4111-8111-111111111111',
  clinicId: '22222222-2222-4222-8222-222222222222',
  doctorId: '33333333-3333-4333-8333-333333333333',
  appointmentId: '44444444-4444-4444-8444-444444444444',
};
const ROUTES_ROOT = join(__dirname, '..', '..', 'src', 'app', 'api', 'patient');
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = (typeof HTTP_METHODS)[number];
type Handler = (
  request: Request,
  context: { params: Promise<typeof ids> },
) => Promise<Response>;

// Deliberate inventories: a new patient route, or a new method on an existing
// one, must be classified here, which pulls it into the boundary matrix.
const ACCOUNT_OWNED: Record<string, readonly Method[]> = {
  dependents: ['GET', 'POST'],
  'dependents/[dependentId]': ['GET', 'PATCH'],
  'dependents/[dependentId]/archive': ['POST'],
  password: ['POST'],
  'saved-doctors': ['GET'],
  'saved-doctors/[clinicId]/[doctorId]': ['PUT', 'DELETE'],
  session: ['GET'],
  visits: ['GET'],
  'visits/[appointmentId]/cancel': ['POST'],
  'visits/[appointmentId]/reschedule': ['POST'],
};
// Routes that cannot require a session, with the reason each is public.
const PUBLIC_BY_DESIGN: Record<string, readonly Method[]> = {
  register: ['POST'], // creates the account
  'recovery/redeem': ['POST'], // a recovery token is the credential
  'session/logout': ['POST'], // idempotent revoke of the caller's own cookie
};
// session also exports the public sign-in POST next to the account-owned GET.
const SIGN_IN: Record<string, readonly Method[]> = { session: ['POST'] };

function discoverRouteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return discoverRouteFiles(path);
    return name === 'route.ts' ? [path] : [];
  });
}
const routeFiles = discoverRouteFiles(ROUTES_ROOT);
function routeKey(file: string): string {
  return relative(ROUTES_ROOT, file).split(sep).slice(0, -1).join('/');
}

function patientToken(
  expiresAt = new Date(Date.now() + 3600_000),
): Promise<string> {
  const fake = { query: async () => ({ rows: [{ user_id: USER }] }) };
  return createPatientSessionToken(USER, expiresAt, fake as never);
}
function staffSignedToken(exp: number): string {
  // Same claim shape, signed with the staff key rather than the derived
  // patient key.
  const payload = Buffer.from(
    JSON.stringify({ sub: USER, sid: 'staff-token-as-patient', exp }),
  ).toString('base64url');
  const mac = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function url(key: string): string {
  const path = key
    .replace('[dependentId]', ids.dependentId)
    .replace('[clinicId]', ids.clinicId)
    .replace('[doctorId]', ids.doctorId)
    .replace('[appointmentId]', ids.appointmentId);
  return `http://localhost/api/patient/${path}`;
}
function request(
  key: string,
  method: Method,
  headers: Record<string, string | undefined>,
): Request {
  const defined = Object.fromEntries(
    Object.entries(headers).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  return new Request(url(key), {
    method,
    headers: { 'content-type': 'application/json', ...defined },
    ...(method === 'GET' ? {} : { body: JSON.stringify({}) }),
  });
}
async function handlerFor(key: string, method: Method): Promise<Handler> {
  const file = routeFiles.find((candidate) => routeKey(candidate) === key);
  if (!file) throw new Error(`missing route module for ${key}`);
  const routeModule = (await import(file)) as Record<string, unknown>;
  const handler = routeModule[method];
  if (typeof handler !== 'function')
    throw new Error(`${key} does not export ${method}`);
  return handler as Handler;
}
async function call(
  key: string,
  method: Method,
  headers: Record<string, string | undefined>,
): Promise<Response> {
  const handler = await handlerFor(key, method);
  return handler(request(key, method, headers), {
    params: Promise.resolve(ids),
  });
}
async function expectRefused(
  response: Response,
  status: number,
  error: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(JSON.parse(await response.text())).toMatchObject({ error });
}

const all = Object.entries(ACCOUNT_OWNED).flatMap(([key, methods]) =>
  methods.map((method) => ({ key, method })),
);
const mutations = all.filter((r) => r.method !== 'GET');

let valid = '';
let expiredPatient = '';
beforeEach(async () => {
  access.value = { sessionLookups: 0, other: [], connects: 0 };
  access.sessionRows = [];
  vi.stubEnv('STAFF_SESSION_SECRET', SECRET);
  valid = await patientToken();
  // Genuine patient-key signature, past expiry: only the expiry check refuses it.
  expiredPatient = await patientToken(new Date(Date.now() - 3600_000));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('patient route inventory', () => {
  it('classifies every discovered route module and exported handler', async () => {
    const discovered: Record<string, Method[]> = {};
    for (const file of routeFiles) {
      const routeModule = (await import(file)) as Record<string, unknown>;
      discovered[routeKey(file)] = HTTP_METHODS.filter(
        (method) => typeof routeModule[method] === 'function',
      );
    }
    const classified: Record<string, Method[]> = {};
    for (const group of [ACCOUNT_OWNED, PUBLIC_BY_DESIGN, SIGN_IN])
      for (const [key, methods] of Object.entries(group))
        classified[key] = [...(classified[key] ?? []), ...methods].sort(
          (a, b) => HTTP_METHODS.indexOf(a) - HTTP_METHODS.indexOf(b),
        );
    expect(discovered).toEqual(classified);
    expect(all).toHaveLength(13);
    expect(mutations).toHaveLength(8);
  });
});

describe.each(all)('$method $key', ({ key, method }) => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const unauthenticated: Record<string, () => string | undefined> = {
    'no session cookie': () => undefined,
    'forged signature': () => `${COOKIE}=${valid.split('.')[0]}.AAAAforged`,
    'expired token': () => `${COOKIE}=${expiredPatient}`,
    'duplicate session cookies': () => `${COOKIE}=${valid}; ${COOKIE}=${valid}`,
    'staff-signed token': () => `${COOKIE}=${staffSignedToken(exp)}`,
  };

  it.each(Object.keys(unauthenticated))(
    'refuses %s before any database access',
    async (label) => {
      const response = await call(key, method, {
        origin: 'http://localhost',
        cookie: unauthenticated[label]!(),
      });
      await expectRefused(response, 401, 'authentication_required');
      expect(access.value).toEqual({
        sessionLookups: 0,
        other: [],
        connects: 0,
      });
    },
  );

  it('refuses a validly signed token whose session row is unknown or revoked', async () => {
    const response = await call(key, method, {
      origin: 'http://localhost',
      cookie: `${COOKIE}=${valid}`,
    });
    await expectRefused(response, 401, 'authentication_required');
    expect(access.value).toEqual({ sessionLookups: 1, other: [], connects: 0 });
  });

  it('positive control: a live session passes authentication', async () => {
    access.sessionRows = [{ id: USER, display_name: 'Control Patient' }];
    const response = await call(key, method, {
      origin: 'http://localhost',
      cookie: `${COOKIE}=${valid}`,
    });
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
    expect(access.value.sessionLookups).toBe(1);
  });
});

const crossSiteOrigins: Record<string, string | undefined> = {
  'missing Origin': undefined,
  'cross-site Origin': 'https://attacker.example',
  'opaque null Origin': 'null',
  'wrong-protocol Origin': 'https://localhost',
};

describe.each(mutations)('$method $key cross-site', ({ key, method }) => {
  it.each(Object.entries(crossSiteOrigins))(
    'refuses %s with a live session after only the session lookup',
    async (_label, origin) => {
      access.sessionRows = [{ id: USER, display_name: 'Control Patient' }];
      const response = await call(key, method, {
        origin,
        cookie: `${COOKIE}=${valid}`,
      });
      await expectRefused(response, 403, 'csrf_rejected');
      expect(access.value).toEqual({
        sessionLookups: 1,
        other: [],
        connects: 0,
      });
    },
  );
});
