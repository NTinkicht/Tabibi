import { beforeEach, describe, expect, it, vi } from 'vitest';

const issue = vi.fn();
const scopeFor = vi.fn();
vi.mock('@/modules/guest-access', () => ({
  GuestAccessRejectedError: class GuestAccessRejectedError extends Error {},
  GuestAccessService: class {
    issue(...args: unknown[]) {
      return issue(...args);
    }
  },
}));
vi.mock('@/platform/database/pool', () => ({ getPool: () => ({}) }));
vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ error: vi.fn() }),
}));
vi.mock('@/platform/http/staff-auth', async (original) => ({
  ...(await original<typeof import('@/platform/http/staff-auth')>()),
  authenticatedClinicScope: (...args: unknown[]) => scopeFor(...args),
}));
import { GuestAccessRejectedError } from '@/modules/guest-access';
import { AuthorizationError } from '@/modules/identity';
import { StaffAuthenticationError } from '@/platform/http/staff-auth';
import { POST } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/status-link/route';

const ids = {
  clinicId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  entryId: '33333333-3333-4333-8333-333333333333',
};
const EXCHANGE = 'exchange-secret-value-0123456789abcdefghijklmnop';

function call(origin: string | null = 'https://tabibi.test') {
  return POST(
    new Request(
      `https://tabibi.test/api/clinics/${ids.clinicId}/sessions/${ids.sessionId}/queue/${ids.entryId}/status-link`,
      { method: 'POST', headers: origin ? { origin } : {} },
    ),
    { params: Promise.resolve(ids) },
  );
}

describe('POST status-link (receptionist-assisted guest link)', () => {
  beforeEach(() => {
    issue.mockReset();
    scopeFor.mockReset();
    scopeFor.mockResolvedValue({
      clinicId: ids.clinicId,
      actorUserId: 'actor-1',
    });
  });

  it('returns a single-use exchange URL once, no-store, bound to the actor and target', async () => {
    const expiresAt = new Date('2026-11-02T10:10:00Z');
    issue.mockResolvedValue({ exchangeId: EXCHANGE, expiresAt });
    const response = await call();
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      statusLink: {
        url: `https://tabibi.test/api/guest/exchange/${EXCHANGE}`,
        expiresAt: expiresAt.toISOString(),
        singleUse: true,
      },
    });
    expect(issue).toHaveBeenCalledWith(
      {
        clinicId: ids.clinicId,
        sessionId: ids.sessionId,
        queueEntryId: ids.entryId,
      },
      'actor-1',
    );
  });

  it('rejects cross-site and missing Origin before any auth or issuance', async () => {
    for (const origin of ['https://attacker.example', null]) {
      const response = await call(origin);
      expect(response.status).toBe(403);
    }
    expect(scopeFor).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it('fails closed with 401 when unauthenticated and issues nothing', async () => {
    scopeFor.mockRejectedValue(new StaffAuthenticationError());
    expect((await call()).status).toBe(401);
    expect(issue).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-receptionist role without leaking the link', async () => {
    issue.mockRejectedValue(new AuthorizationError());
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('/api/guest/exchange/');
  });

  it('returns one generic 409 for unknown, cross-tenant or contact-less entries', async () => {
    issue.mockRejectedValue(new GuestAccessRejectedError());
    const response = await call();
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({
      error: 'conflict',
      message: 'Guest status link unavailable',
    });
    expect(JSON.stringify(body)).not.toContain(ids.entryId);
  });

  it('refuses non-HTTPS deployments instead of minting a plaintext link', async () => {
    const response = await call('http://tabibi.test');
    expect([403, 409]).toContain(response.status);
    expect(issue).not.toHaveBeenCalled();
  });

  it('rejects malformed path ids with 400', async () => {
    const response = await POST(
      new Request('https://tabibi.test/x', {
        method: 'POST',
        headers: { origin: 'https://tabibi.test' },
      }),
      { params: Promise.resolve({ ...ids, entryId: 'not-a-uuid' }) },
    );
    expect(response.status).toBe(400);
    expect(issue).not.toHaveBeenCalled();
  });
});
