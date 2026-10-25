import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const list = vi.fn();
const constructedSecrets: string[] = [];

vi.mock('@/modules/public-availability', () => ({
  PublicBookableSessionService: class {
    list(...args: unknown[]) {
      return list(...args);
    }
  },
}));

vi.mock('@/modules/public-availability-selection', () => ({
  PublicAvailabilitySelectionService: class {
    constructor(_pool: unknown, secret: string) {
      constructedSecrets.push(secret);
    }
  },
}));

vi.mock('@/platform/database/pool', () => ({ getPool: () => ({}) }));
vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import { GET } from '@/app/api/public/bookable-sessions/route';

const SECRET = 'route-test-public-availability-selection-secret-32b';

function request(): Request {
  return new Request('https://tabibi.test/api/public/bookable-sessions', {
    headers: { 'x-request-id': 'tab-p0-03-bookable-1' },
  });
}

describe('GET /api/public/bookable-sessions', () => {
  const original = process.env.PUBLIC_AVAILABILITY_SELECTION_SECRET;

  beforeEach(() => {
    list.mockReset();
    constructedSecrets.length = 0;
    process.env.PUBLIC_AVAILABILITY_SELECTION_SECRET = SECRET;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.PUBLIC_AVAILABILITY_SELECTION_SECRET;
    } else {
      process.env.PUBLIC_AVAILABILITY_SELECTION_SECRET = original;
    }
  });

  it('serializes only the public allow-list with no-store headers', async () => {
    list.mockResolvedValue([
      {
        name: 'Clinique El Amal',
        defaultLocale: 'fr',
        enabledLocales: ['fr', 'ar'],
        id: 'clinic-secret',
        tenantKey: 'tenant-secret',
        doctors: [
          {
            displayName: 'Dr. Amel Benali',
            id: 'doctor-secret',
            userId: 'user-secret',
            sessions: [
              {
                serviceDate: '2099-01-02',
                startsAt: '2099-01-02T08:00:00.000Z',
                endsAt: '2099-01-02T09:00:00.000Z',
                selectionReference: 'v1.iv.ciphertext.tag',
                sessionId: 'session-secret',
                status: 'planned-secret',
              },
            ],
          },
        ],
      },
    ]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('tab-p0-03-bookable-1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const body = await response.json();
    expect(body).toEqual({
      clinics: [
        {
          name: 'Clinique El Amal',
          defaultLocale: 'fr',
          enabledLocales: ['fr', 'ar'],
          doctors: [
            {
              displayName: 'Dr. Amel Benali',
              sessions: [
                {
                  serviceDate: '2099-01-02',
                  startsAt: '2099-01-02T08:00:00.000Z',
                  endsAt: '2099-01-02T09:00:00.000Z',
                  selectionReference: 'v1.iv.ciphertext.tag',
                },
              ],
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(body);
    for (const secret of [
      'clinic-secret',
      'tenant-secret',
      'doctor-secret',
      'user-secret',
      'session-secret',
      'planned-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(constructedSecrets).toEqual([SECRET]);
  });

  it('returns a successful empty result', async () => {
    list.mockResolvedValue([]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clinics: [] });
  });

  it.each([
    ['missing', undefined],
    ['too short', 'short-secret'],
  ])(
    'fails closed without querying when the selection secret is %s',
    async (_label, secret) => {
      if (secret === undefined) {
        delete process.env.PUBLIC_AVAILABILITY_SELECTION_SECRET;
      } else {
        process.env.PUBLIC_AVAILABILITY_SELECTION_SECRET = secret;
      }

      const response = await GET(request());

      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        status: 'error',
        requestId: 'tab-p0-03-bookable-1',
      });
      expect(list).not.toHaveBeenCalled();
      expect(constructedSecrets).toEqual([]);
    },
  );

  it('bounds a stalled query, aborts it and returns a privacy-safe error', async () => {
    let querySignal: AbortSignal | undefined;
    list.mockImplementation((signal: AbortSignal) => {
      querySignal = signal;
      return new Promise<never>(() => {});
    });

    vi.useFakeTimers();
    try {
      const pending = GET(request());
      await vi.advanceTimersByTimeAsync(2_000);
      const response = await pending;

      expect(querySignal?.aborted).toBe(true);
      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await response.json()).toEqual({
        status: 'error',
        requestId: 'tab-p0-03-bookable-1',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
