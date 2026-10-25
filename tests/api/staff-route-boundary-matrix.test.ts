import { createHmac } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TAB-P0-01 (#630): every staff clinic route must reject cross-site
// mutations and unauthenticated access at the HTTP boundary, before any
// database access. The pool is replaced by a counter that throws, so a route
// that reaches persistence fails both on the call count and on the status.
const poolAccess = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/platform/database/pool', () => ({
  getPool: () => {
    poolAccess.count += 1;
    throw new Error('staff route boundary test must not touch the pool');
  },
}));

const SECRET = 'staff-route-boundary-matrix-secret-0123456789';
const COOKIE = 'tabibi_staff_session';
const ids = {
  clinicId: '00000000-0000-4000-8000-000000000001',
  sessionId: '11111111-1111-4111-8111-111111111111',
  appointmentId: '22222222-2222-4222-8222-222222222222',
  entryId: '33333333-3333-4333-8333-333333333333',
  templateId: '44444444-4444-4444-8444-444444444444',
  closureDate: '2026-10-24',
  doctorId: '55555555-5555-4555-8555-555555555555',
  absenceDate: '2026-10-26',
  consultationTypeId: '66666666-6666-4666-8666-666666666666',
};
const ROUTES_ROOT = join(__dirname, '..', '..', 'src', 'app', 'api', 'clinics');
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = (typeof HTTP_METHODS)[number];
type Handler = (
  request: Request,
  context: { params: Promise<typeof ids> },
) => Promise<Response>;

// Deliberate inventory: a new staff route (or a new method on an existing
// one) must be added here, which pulls it into the boundary matrix below.
const EXPECTED: Record<string, readonly Method[]> = {
  '': ['GET', 'PATCH'],
  closures: ['GET', 'POST'],
  'closures/[closureDate]': ['DELETE'],
  'consultation-types': ['GET', 'POST'],
  'consultation-types/[consultationTypeId]': ['PATCH'],
  'doctors/[doctorId]/absences': ['GET', 'POST'],
  'doctors/[doctorId]/absences/[absenceDate]': ['DELETE'],
  'notifications/dead-letters': ['GET'],
  'notifications/dispatch': ['POST'],
  'schedule-generations': ['POST'],
  'schedule-templates': ['GET', 'POST'],
  'schedule-templates/[templateId]': ['PATCH'],
  sessions: ['GET', 'POST'],
  'sessions/[sessionId]/appointments': ['POST'],
  'sessions/[sessionId]/appointments/[appointmentId]': ['PATCH'],
  'sessions/[sessionId]/appointments/bulk-no-show': ['POST'],
  'sessions/[sessionId]/commands': ['POST'],
  'sessions/[sessionId]/dashboard': ['GET'],
  'sessions/[sessionId]/delay': ['POST'],
  'sessions/[sessionId]/queue': ['GET', 'POST'],
  'sessions/[sessionId]/queue/[entryId]/commands': ['POST'],
  'sessions/[sessionId]/queue/[entryId]/reorder': ['POST'],
};

function discoverRouteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return discoverRouteFiles(path);
    return name === 'route.ts' ? [path] : [];
  });
}

const routeFiles = discoverRouteFiles(join(ROUTES_ROOT, '[clinicId]'));
function routeKey(file: string): string {
  return relative(join(ROUTES_ROOT, '[clinicId]'), file)
    .split(sep)
    .slice(0, -1)
    .join('/');
}

function signedToken(sub: string, exp: number): string {
  const payload = Buffer.from(
    JSON.stringify({ sub, sid: 'staff-boundary-session', exp }),
  ).toString('base64url');
  const mac = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

const future = Math.floor(Date.now() / 1000) + 3600;
const valid = signedToken('staff-boundary-subject', future);
const unauthenticatedCookies: Record<string, string | undefined> = {
  'no session cookie': undefined,
  'forged signature': `${COOKIE}=${valid.split('.')[0]}.AAAAforged`,
  'expired signed session': `${COOKIE}=${signedToken('staff-boundary-subject', 1)}`,
  'duplicate session cookies': `${COOKIE}=${valid}; ${COOKIE}=${valid}`,
};

const crossSiteOrigins: Record<string, string | undefined> = {
  'missing Origin': undefined,
  'cross-site Origin': 'https://attacker.example',
  'opaque null Origin': 'null',
  'wrong-protocol Origin': 'https://localhost',
};

function url(key: string): string {
  const path = key
    .replace('[sessionId]', ids.sessionId)
    .replace('[appointmentId]', ids.appointmentId)
    .replace('[entryId]', ids.entryId)
    .replace('[templateId]', ids.templateId)
    .replace('[closureDate]', ids.closureDate)
    .replace('[doctorId]', ids.doctorId)
    .replace('[absenceDate]', ids.absenceDate)
    .replace('[consultationTypeId]', ids.consultationTypeId);
  return `http://localhost/api/clinics/${ids.clinicId}/${path}?date=2026-10-24&limit=5`;
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
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'staff-boundary-matrix',
      ...defined,
    },
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

async function expectRejected(
  response: Response,
  status: number,
  error: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ error });
  expect(text).not.toContain(valid.split('.')[1]);
  expect(poolAccess.count).toBe(0);
}

const mutations = Object.entries(EXPECTED).flatMap(([key, methods]) =>
  methods.filter((m) => m !== 'GET').map((method) => ({ key, method })),
);
const reads = Object.entries(EXPECTED).flatMap(([key, methods]) =>
  methods.filter((m) => m === 'GET').map((method) => ({ key, method })),
);

beforeEach(() => {
  poolAccess.count = 0;
  vi.stubEnv('STAFF_SESSION_SECRET', SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('staff clinic route inventory', () => {
  it('lists every discovered route module and exported handler', async () => {
    const discovered: Record<string, Method[]> = {};
    for (const file of routeFiles) {
      const routeModule = (await import(file)) as Record<string, unknown>;
      discovered[routeKey(file)] = HTTP_METHODS.filter(
        (method) => typeof routeModule[method] === 'function',
      );
    }
    expect(discovered).toEqual(EXPECTED);
    expect(mutations).toHaveLength(20);
    expect(reads).toHaveLength(9);
  });
});

describe.each(mutations)('$method $key', ({ key, method }) => {
  it.each(Object.entries(crossSiteOrigins))(
    'rejects %s before authentication or persistence',
    async (_label, origin) => {
      const handler = await handlerFor(key, method);
      const response = await handler(
        request(key, method, { origin, cookie: `${COOKIE}=${valid}` }),
        { params: Promise.resolve(ids) },
      );
      await expectRejected(response, 403, 'csrf_rejected');
    },
  );

  it.each(Object.entries(unauthenticatedCookies))(
    'rejects a same-origin request with %s before persistence',
    async (_label, cookie) => {
      const handler = await handlerFor(key, method);
      const response = await handler(
        request(key, method, { origin: 'http://localhost', cookie }),
        { params: Promise.resolve(ids) },
      );
      await expectRejected(response, 401, 'authentication_required');
    },
  );
});

describe.each(reads)('$method $key', ({ key, method }) => {
  it.each(Object.entries(unauthenticatedCookies))(
    'rejects %s before persistence',
    async (_label, cookie) => {
      const handler = await handlerFor(key, method);
      const response = await handler(request(key, method, { cookie }), {
        params: Promise.resolve(ids),
      });
      await expectRejected(response, 401, 'authentication_required');
    },
  );
});
