import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSnapshot = vi.fn();
const authenticatedGuestCredentialId = vi.fn();
const query = vi.fn();
const loggerError = vi.fn();

vi.mock('@/modules/guest-access', () => ({
  authenticatedGuestCredentialId: (...args: unknown[]) =>
    authenticatedGuestCredentialId(...args),
  GuestAccessRejectedError: class GuestAccessRejectedError extends Error {},
}));

vi.mock('@/modules/guest-status', () => ({
  GuestStatusService: class GuestStatusService {
    getSnapshot(...args: unknown[]) {
      return getSnapshot(...args);
    }
  },
}));

vi.mock('@/platform/database/pool', () => ({
  getPool: () => ({ query }),
}));

vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ error: loggerError }),
}));

import { GET } from '@/app/api/guest/status/stream/route';
import { GuestAccessRejectedError } from '@/modules/guest-access';

const bearer = '00000000-0000-4000-8000-000000000019.super-secret.signature';
const target = {
  clinicId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  queueEntryId: '00000000-0000-4000-8000-000000000003',
};
const terminalSnapshot = {
  generatedAt: '2026-09-10T17:30:00Z',
  terminal: true as const,
  finalStatus: 'completed',
};
const activeSnapshot = {
  generatedAt: '2026-09-10T17:30:00Z',
  terminal: false as const,
  target,
  publicDisplayLabel: 'G-019',
  queueState: 'checked_in',
  clinicTimezone: 'Africa/Algiers',
  patientsAhead: 1,
  positionKind: 'live' as const,
  arrivalWindow: null,
  session: {
    status: 'open',
    declaredDelayMinutes: null,
    delayVersion: 4,
    queueOrderVersion: 7,
  },
};

function allowedBucket() {
  query.mockResolvedValue({ rows: [{ allowed: true }] });
}

function requestWithBearer(signal?: AbortSignal) {
  return new Request('https://tabibi.test/api/guest/status/stream', {
    headers: { cookie: `__Host-tabibi_guest=${bearer}` },
    signal,
  });
}

describe('GET /api/guest/status/stream', () => {
  beforeEach(() => {
    getSnapshot.mockReset();
    authenticatedGuestCredentialId.mockReset();
    query.mockReset();
    loggerError.mockReset();
    authenticatedGuestCredentialId.mockReturnValue(
      '00000000-0000-4000-8000-000000000019',
    );
    allowedBucket();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a missing guest credential with hardened no-store headers', async () => {
    const response = await GET(
      new Request('https://tabibi.test/api/guest/status/stream'),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('throttles before guest-status lookup when the connection bucket is exhausted', async () => {
    query.mockResolvedValue({ rows: [{ allowed: false }] });

    const response = await GET(requestWithBearer());

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('hardens a rate-limit storage failure instead of exposing a default framework response', async () => {
    query.mockRejectedValue(new Error('postgres unavailable'));

    const response = await GET(requestWithBearer());

    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    expect(await response.json()).toEqual({ error: 'Guest access rejected' });
    expect(loggerError).toHaveBeenCalledWith(
      'guest status stream bootstrap failed',
    );
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('streams an authorized terminal snapshot once and never emits bearer material', async () => {
    getSnapshot.mockResolvedValue(terminalSnapshot);

    const response = await GET(requestWithBearer());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toContain('event: status');
    expect(body).toContain(JSON.stringify(terminalSnapshot));
    expect(body).not.toContain(bearer);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(getSnapshot).toHaveBeenCalledWith(
      bearer,
      expect.any(Date),
      expect.any(AbortSignal),
    );
  });

  it('suppresses timestamp-only refreshes but emits guest-visible projection changes even when session versions are unchanged', async () => {
    vi.useFakeTimers();
    const sameProjection = {
      ...activeSnapshot,
      generatedAt: '2026-09-10T17:30:15Z',
    };
    const changedProjection = {
      ...activeSnapshot,
      generatedAt: '2026-09-10T17:30:30Z',
      patientsAhead: 0,
    };
    getSnapshot
      .mockResolvedValueOnce(activeSnapshot)
      .mockResolvedValueOnce(sameProjection)
      .mockResolvedValueOnce(changedProjection);

    const response = await GET(requestWithBearer());
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain(JSON.stringify(activeSnapshot));

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toContain(JSON.stringify(changedProjection));
    expect(second).not.toContain(JSON.stringify(sameProjection));
    expect(changedProjection.session.queueOrderVersion).toBe(
      activeSnapshot.session.queueOrderVersion,
    );
    expect(getSnapshot).toHaveBeenCalledTimes(3);
    await reader.cancel();
  });

  it('closes promptly when the client aborts after the first active event', async () => {
    const controller = new AbortController();
    getSnapshot.mockResolvedValue(activeSnapshot);

    const response = await GET(requestWithBearer(controller.signal));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: status');
    controller.abort();

    const end = await reader!.read();
    expect(end.done).toBe(true);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });

  it('aborts a refresh lookup that is already pending when the client disconnects', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let refreshSignal: AbortSignal | undefined;
    getSnapshot
      .mockResolvedValueOnce(activeSnapshot)
      .mockImplementationOnce(
        (_bearer: string, _now: Date, signal: AbortSignal) =>
          new Promise((_, reject) => {
            refreshSignal = signal;
            signal.addEventListener(
              'abort',
              () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      );

    const response = await GET(requestWithBearer(controller.signal));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      'event: status',
    );

    await vi.advanceTimersByTimeAsync(15_000);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(refreshSignal).toBe(controller.signal);
    expect(refreshSignal?.aborted).toBe(false);

    controller.abort();
    const end = await reader.read();
    expect(end.done).toBe(true);
    expect(refreshSignal?.aborted).toBe(true);
  });

  it('closes without leaking details when authorization is revoked during refresh', async () => {
    vi.useFakeTimers();
    getSnapshot
      .mockResolvedValueOnce(activeSnapshot)
      .mockRejectedValueOnce(new GuestAccessRejectedError());

    const response = await GET(requestWithBearer());
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('event: status');

    await vi.advanceTimersByTimeAsync(15_000);
    const end = await reader.read();
    expect(end.done).toBe(true);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });
});
