import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSnapshot = vi.fn();
const authenticatedGuestCredentialId = vi.fn();
const query = vi.fn();

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
  getLogger: () => ({ error: vi.fn() }),
}));

import { GET } from '@/app/api/guest/status/stream/route';
import { GuestAccessRejectedError } from '@/modules/guest-access';

const bearer = '00000000-0000-4000-8000-000000000019.super-secret.signature';
const terminalSnapshot = {
  generatedAt: '2026-09-10T17:30:00Z',
  terminal: true,
  finalStatus: 'completed',
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
    authenticatedGuestCredentialId.mockReturnValue(
      '00000000-0000-4000-8000-000000000019',
    );
    allowedBucket();
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

  it('streams an authorized terminal snapshot and never emits bearer material', async () => {
    getSnapshot.mockResolvedValue(terminalSnapshot);

    const response = await GET(requestWithBearer());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toContain('event: status');
    expect(body).toContain(JSON.stringify(terminalSnapshot));
    expect(body).not.toContain(bearer);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(getSnapshot).toHaveBeenNthCalledWith(1, bearer);
    expect(getSnapshot).toHaveBeenNthCalledWith(2, bearer);
  });

  it('closes without an event when authorization is revoked after bootstrap', async () => {
    getSnapshot
      .mockResolvedValueOnce({
        generatedAt: '2026-09-10T17:30:00Z',
        terminal: false,
        publicDisplayLabel: 'G-019',
        queueState: 'waiting',
        clinicTimezone: 'Africa/Algiers',
        patientsAhead: null,
        positionKind: 'provisional',
        arrivalWindow: null,
        session: { status: 'open', declaredDelayMinutes: null },
      })
      .mockRejectedValueOnce(new GuestAccessRejectedError());

    const response = await GET(requestWithBearer());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toBe('');
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('stops promptly when the client aborts after the first active event', async () => {
    const controller = new AbortController();
    const activeSnapshot = {
      generatedAt: '2026-09-10T17:30:00Z',
      terminal: false,
      publicDisplayLabel: 'G-019',
      queueState: 'checked_in',
      clinicTimezone: 'Africa/Algiers',
      patientsAhead: 1,
      positionKind: 'live',
      arrivalWindow: null,
      session: { status: 'open', declaredDelayMinutes: null },
    };
    getSnapshot.mockResolvedValue(activeSnapshot);

    const response = await GET(requestWithBearer(controller.signal));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: status');
    controller.abort();

    const end = await reader!.read();
    expect(end.done).toBe(true);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });
});
