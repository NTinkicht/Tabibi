import { beforeEach, describe, expect, it, vi } from 'vitest';

const consume = vi.fn();
vi.mock('@/modules/guest-access', () => ({
  GuestAccessRejectedError: class extends Error {},
  GuestAccessService: class {
    consume(...args: unknown[]) {
      return consume(...args);
    }
  },
}));
vi.mock('@/platform/database/pool', () => ({ getPool: () => ({}) }));
vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ error: vi.fn() }),
}));
import { GET } from '@/app/api/guest/exchange/[exchangeId]/route';

describe('GET /api/guest/exchange/:exchangeId', () => {
  beforeEach(() => consume.mockReset());
  it('sets a hardened bearer cookie and redirects without credentials', async () => {
    consume.mockResolvedValue({
      bearer: 'raw-bearer-secret',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const response = await GET(
      new Request('https://tabibi.test/api/guest/exchange/raw'),
      {
        params: Promise.resolve({ exchangeId: 'x'.repeat(43) }),
      },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/guest/status');
    expect(response.headers.get('location')).not.toContain('raw-bearer-secret');
    expect(response.headers.get('set-cookie')).toMatch(
      /^__Host-tabibi_guest=raw-bearer-secret; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
  });

  it('returns indistinguishable hardened rejection responses', async () => {
    const response = await GET(
      new Request('https://tabibi.test/api/guest/exchange/raw'),
      {
        params: Promise.resolve({ exchangeId: 'invalid' }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Guest access exchange rejected');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(consume).not.toHaveBeenCalled();
  });
});
