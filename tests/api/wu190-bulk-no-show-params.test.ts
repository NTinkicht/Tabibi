import { beforeEach, describe, expect, it, vi } from 'vitest';

type StaffAuthModule = typeof import('@/platform/http/staff-auth');

const resolveWaiting = vi.hoisted(() => vi.fn());
const authenticatedClinicScope = vi.hoisted(() => vi.fn());

vi.mock('@/modules/appointment/bulk-no-show', () => ({
  AppointmentBulkNoShowService: class {
    resolveWaiting(...args: unknown[]) {
      return resolveWaiting(...args);
    }
  },
}));

vi.mock('@/platform/http/staff-auth', async (importOriginal) => {
  const actual = await importOriginal<StaffAuthModule>();
  return {
    ...actual,
    authenticatedClinicScope,
  };
});

vi.mock('@/platform/database/pool', () => ({ getPool: () => ({}) }));

import { POST } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/appointments/bulk-no-show/route';

const clinicId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000002';

function request(clinic: string, session: string) {
  return new Request(
    `http://localhost/api/clinics/${clinic}/sessions/${session}/appointments/bulk-no-show`,
    {
      method: 'POST',
      headers: { origin: 'http://localhost' },
      body: JSON.stringify({ reason: 'Reception confirmed no-shows' }),
    },
  );
}

function context(clinic: string, session: string) {
  return { params: Promise.resolve({ clinicId: clinic, sessionId: session }) };
}

describe('WU190 bulk no-show path validation', () => {
  beforeEach(() => {
    resolveWaiting.mockReset();
    authenticatedClinicScope.mockReset();
    authenticatedClinicScope.mockResolvedValue({
      clinicId,
      actorUserId: 'actor',
    });
    resolveWaiting.mockResolvedValue({ resolvedCount: 0 });
  });

  it('rejects malformed path UUIDs before auth or bulk service work', async () => {
    for (const [clinic, session] of [
      ['not-a-uuid', sessionId],
      [clinicId, 'not-a-uuid'],
    ]) {
      const response = await POST(
        request(clinic, session),
        context(clinic, session),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid_request');
    }
    expect(authenticatedClinicScope).not.toHaveBeenCalled();
    expect(resolveWaiting).not.toHaveBeenCalled();
  });

  it('preserves valid bulk no-show forwarding', async () => {
    const response = await POST(
      request(clinicId, sessionId),
      context(clinicId, sessionId),
    );
    expect(response.status).toBe(200);
    expect(authenticatedClinicScope).toHaveBeenCalledTimes(1);
    expect(resolveWaiting).toHaveBeenCalledTimes(1);
  });
});
