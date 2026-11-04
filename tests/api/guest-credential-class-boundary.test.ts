import { beforeEach, describe, expect, it, vi } from 'vitest';

// TAB-P0-08/09/12: the booking-origin Authorization bearer and the
// exchange-origin HttpOnly status cookie are distinct, non-interchangeable
// credential classes. Each route must ignore the other class entirely: no
// credential verification and no service call may happen.
const serviceCalls = vi.fn();
const credentialChecks = vi.fn();
const query = vi.fn();

function spyService() {
  return class SpyService {
    constructor() {
      return new Proxy(
        {},
        {
          get: (_target, property) => () => {
            serviceCalls(String(property));
            throw new Error('service must not be reached');
          },
        },
      );
    }
  };
}

vi.mock('@/modules/public-guest-booking-status', async (original) => ({
  ...(await original<object>()),
  PublicGuestBookingStatusService: spyService(),
}));
vi.mock('@/modules/public-guest-live-queue-status', async (original) => ({
  ...(await original<object>()),
  PublicGuestLiveQueueStatusService: spyService(),
}));
vi.mock('@/modules/public-guest-booking-check-in', async (original) => ({
  ...(await original<object>()),
  PublicGuestBookingCheckInService: spyService(),
}));
vi.mock('@/modules/public-guest-booking-cancellation', async (original) => ({
  ...(await original<object>()),
  PublicGuestBookingCancellationService: spyService(),
}));
vi.mock('@/modules/guest-status', async (original) => ({
  ...(await original<object>()),
  GuestStatusService: spyService(),
}));
vi.mock('@/modules/guest-notification-inbox', async (original) => ({
  ...(await original<object>()),
  GuestNotificationInboxService: spyService(),
}));
vi.mock('@/modules/guest-access', async (original) => {
  const actual = await original<typeof import('@/modules/guest-access')>();
  return {
    ...actual,
    authenticatedGuestCredentialId: (...args: unknown[]) => {
      credentialChecks(...args);
      return null;
    },
  };
});
vi.mock('@/platform/database/pool', () => ({ getPool: () => ({ query }) }));
vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST as bookingCancel } from '@/app/api/public/bookings/cancel/route';
import { POST as bookingCheckIn } from '@/app/api/public/bookings/check-in/route';
import { GET as liveQueueStatus } from '@/app/api/public/bookings/live-queue-status/route';
import { GET as liveQueueStream } from '@/app/api/public/bookings/live-queue-stream/route';
import { GET as bookingStatus } from '@/app/api/public/bookings/status/route';
import { GET as guestInbox } from '@/app/api/guest/inbox/route';
import { POST as guestInboxRead } from '@/app/api/guest/inbox/[itemId]/read/route';
import { GET as guestStatus } from '@/app/api/guest/status/route';
import { GET as guestStatusStream } from '@/app/api/guest/status/stream/route';

const credential = '00000000-0000-4000-8000-000000000019.secret.signature';
const cookieOnly = { cookie: `__Host-tabibi_guest=${credential}` };
const bearerOnly = { authorization: `Bearer ${credential}` };
const url = 'https://tabibi.test/api/x';
const body = JSON.stringify({
  operationId: '00000000-0000-4000-8000-0000000000aa',
});

const authorizationRoutes: Array<[string, () => Promise<Response>, number]> = [
  [
    'bookings/status',
    () => bookingStatus(new Request(url, { headers: cookieOnly })),
    400,
  ],
  [
    'bookings/live-queue-status',
    () => liveQueueStatus(new Request(url, { headers: cookieOnly })),
    400,
  ],
  [
    'bookings/live-queue-stream',
    () => liveQueueStream(new Request(url, { headers: cookieOnly })),
    400,
  ],
  [
    'bookings/check-in',
    () =>
      bookingCheckIn(
        new Request(url, { method: 'POST', headers: cookieOnly, body }),
      ),
    404,
  ],
  [
    'bookings/cancel',
    () =>
      bookingCancel(
        new Request(url, { method: 'POST', headers: cookieOnly, body }),
      ),
    400,
  ],
];

const itemId = '00000000-0000-4000-8000-0000000000bb';
const cookieRoutes: Array<[string, () => Promise<Response>]> = [
  [
    'guest/status',
    () => guestStatus(new Request(url, { headers: bearerOnly })),
  ],
  [
    'guest/status/stream',
    () => guestStatusStream(new Request(url, { headers: bearerOnly })),
  ],
  ['guest/inbox', () => guestInbox(new Request(url, { headers: bearerOnly }))],
  [
    'guest/inbox/[itemId]/read',
    () =>
      guestInboxRead(
        new Request(url, { method: 'POST', headers: bearerOnly }),
        { params: Promise.resolve({ itemId }) },
      ),
  ],
];

describe('guest credential class boundary', () => {
  beforeEach(() => {
    serviceCalls.mockReset();
    credentialChecks.mockReset();
    query.mockReset();
    query.mockResolvedValue({ rows: [{ allowed: true }] });
  });

  it.each(authorizationRoutes)(
    'Authorization-only route %s ignores the exchange status cookie',
    async (_name, call, expectedStatus) => {
      const response = await call();

      expect(response.status).toBe(expectedStatus);
      expect(serviceCalls).not.toHaveBeenCalled();
      expect(credentialChecks).not.toHaveBeenCalled();
    },
  );

  it.each(cookieRoutes)(
    'cookie-only route %s ignores the booking Authorization bearer',
    async (_name, call) => {
      const response = await call();

      expect(response.status).toBe(401);
      expect(serviceCalls).not.toHaveBeenCalled();
      expect(credentialChecks).not.toHaveBeenCalled();
    },
  );
});
