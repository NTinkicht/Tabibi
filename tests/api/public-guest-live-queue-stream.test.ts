import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const query = vi.fn();
const credentialId = vi.fn();
const loggerError = vi.fn();

vi.mock('@/modules/guest-access', () => ({
  authenticatedGuestCredentialId: (...args: unknown[]) => credentialId(...args),
}));
vi.mock('@/modules/public-guest-live-queue-status', () => ({
  PublicGuestLiveQueueStatusRejectedError: class extends Error {},
  PublicGuestLiveQueueStatusService: class {
    get(...args: unknown[]) {
      return get(...args);
    }
  },
}));
vi.mock('@/platform/database/pool', () => ({
  getPool: () => ({ query }),
}));
vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ error: loggerError }),
}));

import {
  encodeChangeHint,
  GET,
} from '@/app/api/public/bookings/live-queue-stream/route';

const bearer = 'credential-id.secret.signature';
const active = {
  bookingState: 'confirmed',
  queueState: 'checked_in',
  pauseStatus: null,
  closureStatus: null,
  activeConsultationRemainingMinutes: null,
  eta: { patientsAhead: 2, revision: 'revision-1' },
};

function request(headers: HeadersInit = {}, signal?: AbortSignal) {
  return new Request(
    'https://tabibi.test/api/public/bookings/live-queue-stream',
    {
      headers,
      signal,
    },
  );
}

describe('GET public booking live queue stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    get.mockReset();
    query.mockReset().mockResolvedValue({ rows: [{ allowed: true }] });
    credentialId.mockReset().mockReturnValue('credential-id');
    loggerError.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it('accepts the bearer only from the Authorization header', async () => {
    const response = await GET(request());
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();

    credentialId.mockClear();
    const controller = new AbortController();
    await GET(
      request(
        { authorization: `Bearer ${bearer}`, cookie: 'guest=unrelated' },
        controller.signal,
      ),
    );
    controller.abort();
    expect(credentialId).toHaveBeenCalledWith(bearer);
    expect(get).toHaveBeenCalledWith(bearer, expect.any(AbortSignal));
  });

  it('emits an exact content-free hint when the authorized snapshot changes', async () => {
    const controller = new AbortController();
    get.mockResolvedValueOnce(active).mockResolvedValueOnce({
      ...active,
      eta: { patientsAhead: 1, revision: 'revision-2' },
    });
    const response = await GET(
      request({ authorization: `Bearer ${bearer}` }, controller.signal),
    );
    const reader = response.body!.getReader();
    await vi.advanceTimersByTimeAsync(5_000);
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toBe('event: change\ndata: {}\n\n');
    expect(chunk).not.toContain(bearer);
    expect(chunk).not.toContain('patientsAhead');
    expect(response.headers.get('cache-control')).toBe('no-store');
    controller.abort();
  });

  it('uses hashed credential rate buckets and rejects exhausted connections', async () => {
    query.mockResolvedValue({ rows: [{ allowed: false }] });
    const response = await GET(request({ authorization: `Bearer ${bearer}` }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(JSON.stringify(query.mock.calls)).not.toContain(bearer);
    expect(get).not.toHaveBeenCalled();
  });

  it('prunes expired rate buckets while preserving hashed limits', async () => {
    const controller = new AbortController();
    await GET(
      request({ authorization: `Bearer ${bearer}` }, controller.signal),
    );
    const sql = String(query.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain('WITH cleanup AS');
    expect(sql).toContain('DELETE FROM guest_status_rate_limit_buckets');
    expect(sql).toContain('WHERE bucket_key <> $1');
    expect(JSON.stringify(query.mock.calls)).not.toContain(bearer);
    controller.abort();
  });

  it('stops pending stream DB reads on reader cancellation', async () => {
    const response = await GET(request({ authorization: `Bearer ${bearer}` }));
    const reader = response.body!.getReader();
    expect(get).toHaveBeenCalledTimes(1);
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(get).toHaveBeenCalledTimes(1);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('formats the only permitted event payload exactly', () => {
    expect(new TextDecoder().decode(encodeChangeHint())).toBe(
      'event: change\ndata: {}\n\n',
    );
  });
});
