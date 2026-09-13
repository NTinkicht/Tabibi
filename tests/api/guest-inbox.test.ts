import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSnapshot = vi.fn();
const markRead = vi.fn();
const authenticatedGuestCredentialId = vi.fn();
const query = vi.fn();
const loggerError = vi.fn();

vi.mock('@/modules/guest-access', () => ({
  authenticatedGuestCredentialId: (...args: unknown[]) =>
    authenticatedGuestCredentialId(...args),
  GuestAccessRejectedError: class GuestAccessRejectedError extends Error {},
}));

vi.mock('@/modules/guest-notification-inbox', () => ({
  GuestNotificationInboxService: class GuestNotificationInboxService {
    getSnapshot(...args: unknown[]) {
      return getSnapshot(...args);
    }
    markRead(...args: unknown[]) {
      return markRead(...args);
    }
  },
}));

vi.mock('@/platform/database/pool', () => ({
  getPool: () => ({ query }),
}));

vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ error: loggerError }),
}));

import { POST } from '@/app/api/guest/inbox/[itemId]/read/route';
import { GET } from '@/app/api/guest/inbox/route';

const bearer = '00000000-0000-4000-8000-000000000010.secret.signature';
const credentialId = '00000000-0000-4000-8000-000000000010';
const itemId = '00000000-0000-4000-8000-000000000011';
const item = {
  id: itemId,
  clinicId: '00000000-0000-4000-8000-000000000001',
  subjectKind: 'visit_patient',
  subjectId: '00000000-0000-4000-8000-000000000004',
  providerIdempotencyKey: 'provider-secret-routing-key',
  templateId: 'turn_approaching_v1',
  locale: 'fr',
  direction: 'ltr',
  title: 'Votre tour approche',
  body: 'Veuillez vous préparer.',
  createdAt: '2026-09-13T07:00:00.000Z',
  readAt: null,
};
const publicItem = {
  id: itemId,
  locale: 'fr',
  direction: 'ltr',
  title: 'Votre tour approche',
  body: 'Veuillez vous préparer.',
  createdAt: '2026-09-13T07:00:00.000Z',
  readAt: null,
};

function request(path: string) {
  return new Request(`https://tabibi.test${path}`, {
    headers: { cookie: `__Host-tabibi_guest=${bearer}` },
  });
}

function context(id = itemId) {
  return { params: Promise.resolve({ itemId: id }) };
}

describe('guest inbox API', () => {
  beforeEach(() => {
    getSnapshot.mockReset();
    markRead.mockReset();
    authenticatedGuestCredentialId.mockReset();
    query.mockReset();
    loggerError.mockReset();
    authenticatedGuestCredentialId.mockReturnValue(credentialId);
    query.mockResolvedValue({ rows: [{ allowed: true }] });
  });

  it(
    'passes only the bearer and bounded limit to the inbox service and returns a privacy-minimal no-store response',
    async () => {
      getSnapshot.mockResolvedValue({ items: [item], unreadCount: 1 });

      const response = await GET(
        request(
          '/api/guest/inbox?limit=999&clinicId=attacker&subjectId=attacker&subjectKind=account',
        ),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(getSnapshot).toHaveBeenCalledWith(bearer, 50);
      expect(getSnapshot).toHaveBeenCalledTimes(1);
      await expect(response.json()).resolves.toEqual({
        items: [publicItem],
        unreadCount: 1,
      });
    },
  );

  it(
    'rejects a missing bearer before inbox lookup with hardened headers',
    async () => {
      const response = await GET(
        new Request('https://tabibi.test/api/guest/inbox'),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-security-policy')).toContain(
        "default-src 'none'",
      );
      expect(getSnapshot).not.toHaveBeenCalled();
    },
  );

  it(
    'marks one validated item id read using only the bearer-derived service scope and returns only public item fields',
    async () => {
      const readAt = '2026-09-13T07:05:00.000Z';
      markRead.mockResolvedValue({ ...item, readAt });

      const response = await POST(
        request(`/api/guest/inbox/${itemId}/read`),
        context(),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(markRead).toHaveBeenCalledWith(bearer, itemId);
      expect(markRead).toHaveBeenCalledTimes(1);
      await expect(response.json()).resolves.toEqual({ ...publicItem, readAt });
    },
  );

  it(
    'uses the same generic not-found response for malformed and wrong-scope item ids',
    async () => {
      const malformed = await POST(
        request('/api/guest/inbox/not-an-id/read'),
        context('not-an-id'),
      );
      expect(malformed.status).toBe(404);
      await expect(malformed.json()).resolves.toEqual({
        error: 'Notification not found',
      });
      expect(markRead).not.toHaveBeenCalled();

      markRead.mockResolvedValue(null);
      const foreign = await POST(
        request(`/api/guest/inbox/${itemId}/read`),
        context(),
      );
      expect(foreign.status).toBe(404);
      await expect(foreign.json()).resolves.toEqual({
        error: 'Notification not found',
      });
    },
  );

  it(
    'throttles before guest inbox access when the shared bucket is exhausted',
    async () => {
      query.mockResolvedValue({ rows: [{ allowed: false }] });

      const response = await GET(request('/api/guest/inbox'));

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('60');
      expect(getSnapshot).not.toHaveBeenCalled();
    },
  );
});
