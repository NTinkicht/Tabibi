import { beforeEach, describe, expect, it, vi } from 'vitest';

const getStatus = vi.fn();

vi.mock('@/modules/public-guest-live-queue-status', () => ({
  PublicGuestLiveQueueStatusRejectedError: class extends Error {},
  PublicGuestLiveQueueStatusService: class {
    get(...args: unknown[]) {
      return getStatus(...args);
    }
  },
}));

vi.mock('@/platform/database/pool', () => ({ getPool: () => ({}) }));
vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import { GET } from '@/app/api/public/bookings/live-queue-status/route';

function request(): Request {
  return new Request(
    'https://tabibi.test/api/public/bookings/live-queue-status',
    {
      headers: {
        authorization: 'Bearer opaque-guest-capability',
        'x-request-id': 'wu81-confidence-contract',
      },
    },
  );
}

describe('WU81 guest ETA confidence HTTP contract', () => {
  beforeEach(() => {
    getStatus.mockReset();
  });

  it.each([
    {
      minWaitMinutes: 8,
      maxWaitMinutes: 8,
      confidence: 'high',
      midpointMinutes: 8,
      uncertaintyWidthMinutes: 0,
    },
    {
      minWaitMinutes: 10,
      maxWaitMinutes: 25,
      confidence: 'medium',
      midpointMinutes: 17.5,
      uncertaintyWidthMinutes: 15,
    },
    {
      minWaitMinutes: 10,
      maxWaitMinutes: 26,
      confidence: 'low',
      midpointMinutes: 18,
      uncertaintyWidthMinutes: 16,
    },
  ] as const)(
    'classifies [$minWaitMinutes,$maxWaitMinutes] as $confidence',
    async ({
      minWaitMinutes,
      maxWaitMinutes,
      confidence,
      midpointMinutes,
      uncertaintyWidthMinutes,
    }) => {
      getStatus.mockResolvedValueOnce({
        bookingState: 'checked_in',
        queueState: 'checked_in',
        eta: {
          patientsAhead: 1,
          minWaitMinutes,
          maxWaitMinutes,
          estimateSource: 'historical_median',
          revision: 'eta-v1-a1b2c3d4',
        },
      });

      const response = await GET(request());

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await response.json()).toEqual({
        bookingState: 'checked_in',
        queueState: 'checked_in',
        eta: {
          patientsAhead: 1,
          minWaitMinutes,
          maxWaitMinutes,
          estimateSource: 'historical_median',
          revision: 'eta-v1-a1b2c3d4',
          summary: {
            midpointMinutes,
            uncertaintyWidthMinutes,
            confidence,
          },
        },
      });
    },
  );

  it('preserves eta null without fabricating a summary', async () => {
    getStatus.mockResolvedValueOnce({
      bookingState: 'confirmed',
      queueState: 'waiting',
      eta: null,
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bookingState: 'confirmed',
      queueState: 'waiting',
      eta: null,
    });
  });
});
