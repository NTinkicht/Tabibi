import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceCalls = vi.fn();
const query = vi.fn();
const credentialId = vi.fn();

function spyService() {
  return class SpyService {
    constructor() {
      return new Proxy(
        {},
        {
          get: (_target, property) => () => {
            serviceCalls(String(property));
            throw new Error('service reached');
          },
        },
      );
    }
  };
}

vi.mock('@/modules/guest-access', () => ({
  authenticatedGuestCredentialId: (...args: unknown[]) => credentialId(...args),
}));
vi.mock('@/modules/public-guest-booking-status', () => ({
  PublicGuestBookingStatusRejectedError: class extends Error {},
  PublicGuestBookingStatusService: spyService(),
}));
vi.mock('@/modules/public-guest-live-queue-status', () => ({
  PublicGuestLiveQueueStatusRejectedError: class extends Error {},
  PublicGuestLiveQueueStatusService: spyService(),
}));
vi.mock('@/modules/public-guest-booking-check-in', () => ({
  PublicGuestBookingCheckInRejectedError: class extends Error {},
  PublicGuestBookingCheckInValidationError: class extends Error {},
  PublicGuestBookingCheckInService: spyService(),
}));
vi.mock('@/modules/public-guest-booking-cancellation', () => ({
  PublicGuestBookingCancellationRejectedError: class extends Error {},
  PublicGuestBookingCancellationService: spyService(),
}));
vi.mock('@/platform/database/pool', () => ({ getPool: () => ({ query }) }));
vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import { POST as cancel } from '@/app/api/public/bookings/cancel/route';
import { POST as checkIn } from '@/app/api/public/bookings/check-in/route';
import { GET as liveQueueStatus } from '@/app/api/public/bookings/live-queue-status/route';
import { GET as status } from '@/app/api/public/bookings/status/route';
import {
  PUBLIC_BOOKING_BEARER_CREDENTIAL_LIMITS,
  PUBLIC_BOOKING_BEARER_UNTRUSTED_LIMIT,
} from '@/platform/http/public-booking-bearer-rate-limit';

const bearer = 'opaque-booking-bearer.secret.signature';
const base = 'https://tabibi.test/api/public/bookings';

function get(path: string, headers: HeadersInit = {}): Request {
  return new Request(`${base}/${path}`, { headers });
}
function post(path: string, headers: HeadersInit = {}): Request {
  return new Request(`${base}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ operationId: 'op-1' }),
  });
}

const routes: ReadonlyArray<
  [string, string, (headers: HeadersInit) => Promise<Response>]
> = [
  ['status', 'status', (h) => status(get('status', h))],
  [
    'live-queue-status',
    'live-queue-status',
    (h) => liveQueueStatus(get('live-queue-status', h)),
  ],
  ['check-in', 'check-in', (h) => checkIn(post('check-in', h))],
  ['cancel', 'cancel', (h) => cancel(post('cancel', h))],
];

describe('public booking bearer routes rate limit', () => {
  beforeEach(() => {
    serviceCalls.mockReset();
    query.mockReset();
    credentialId.mockReset();
    credentialId.mockReturnValue('credential-1');
    query.mockResolvedValue({ rows: [{ allowed: true }] });
  });

  it.each(routes)(
    '%s reaches the service while the credential budget allows it',
    async (_name, _scope, call) => {
      await call({ authorization: `Bearer ${bearer}` });
      expect(serviceCalls).toHaveBeenCalledTimes(1);
    },
  );

  it.each(routes)(
    '%s answers 429 with Retry-After and never reaches the service when exhausted',
    async (_name, _scope, call) => {
      query.mockResolvedValue({ rows: [{ allowed: false }] });
      const response = await call({ authorization: `Bearer ${bearer}` });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('60');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ error: 'rate_limited' });
      expect(serviceCalls).not.toHaveBeenCalled();
    },
  );

  it.each(routes)(
    '%s keys the bucket on the hashed authenticated credential, per route',
    async (_name, scope, call) => {
      await call({ authorization: `Bearer ${bearer}` });
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('guest_status_rate_limit_buckets');
      expect(params[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(params[1]).toBe(
        PUBLIC_BOOKING_BEARER_CREDENTIAL_LIMITS[
          scope as keyof typeof PUBLIC_BOOKING_BEARER_CREDENTIAL_LIMITS
        ],
      );
      expect(params[2]).toBe(60_000);
      expect(JSON.stringify(query.mock.calls)).not.toContain(bearer);
      expect(JSON.stringify(query.mock.calls)).not.toContain('credential-1');
    },
  );

  it('uses distinct buckets per route for one credential', async () => {
    for (const [, , call] of routes) {
      await call({ authorization: `Bearer ${bearer}` });
    }
    const keys = query.mock.calls.map((c) => (c[1] as unknown[])[0]);
    expect(new Set(keys).size).toBe(routes.length);
  });

  it.each(routes)(
    '%s throttles missing or forged bearers in the small untrusted bucket',
    async (_name, _scope, call) => {
      credentialId.mockReturnValue(null);
      await call({ authorization: `Bearer ${bearer}` });
      await call({});
      for (const [, params] of query.mock.calls as [string, unknown[]][]) {
        expect(params[1]).toBe(PUBLIC_BOOKING_BEARER_UNTRUSTED_LIMIT);
      }
      expect(query).toHaveBeenCalledTimes(2);
    },
  );

  it('does not trust forwarding headers to choose a bucket', async () => {
    await status(
      get('status', {
        authorization: `Bearer ${bearer}`,
        'x-forwarded-for': '203.0.113.9',
      }),
    );
    expect(JSON.stringify(query.mock.calls)).not.toContain('203.0.113.9');
  });
});
