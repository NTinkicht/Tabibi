import { beforeEach, describe, expect, it, vi } from 'vitest';

type StaffAuthModule = typeof import('@/platform/http/staff-auth');

const createManual = vi.hoisted(() => vi.fn());
vi.mock('@/modules/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/session')>();
  return {
    ...actual,
    SessionService: class {
      createManual(...args: unknown[]) {
        return createManual(...args);
      }
    },
  };
});
vi.mock('@/platform/http/staff-auth', async (importOriginal) => {
  const actual = await importOriginal<StaffAuthModule>();
  return {
    ...actual,
    authenticatedClinicScope: async (_request: Request, clinicId: string) => ({
      clinicId,
      actorUserId: 'actor',
    }),
  };
});
vi.mock('@/platform/database/pool', () => ({ getPool: () => ({}) }));

import { POST } from '@/app/api/clinics/[clinicId]/sessions/route';

const clinicId = '00000000-0000-4000-8000-000000000001';
const doctorId = '00000000-0000-4000-8000-000000000002';
const url = `http://localhost/api/clinics/${clinicId}/sessions`;
const context = () => ({ params: Promise.resolve({ clinicId }) });
const base = {
  doctorId,
  serviceDate: '2028-02-29',
  startsAt: '2028-02-29T09:00:00.000Z',
  endsAt: '2028-02-29T11:00:00+01:00',
};
function post(body: Record<string, unknown>) {
  return POST(
    new Request(url, {
      method: 'POST',
      headers: { origin: 'http://localhost' },
      body: JSON.stringify(body),
    }),
    context(),
  );
}

describe('WU184 staff session instant ingress', () => {
  beforeEach(() => {
    createManual.mockReset();
    createManual.mockResolvedValue({ id: 'created' });
  });

  it('rejects normalized, ambiguous and coerced instants before service/DB work', async () => {
    for (const invalid of [
      '2026-02-29T09:00:00Z',
      '2028-02-30T09:00:00Z',
      '2026-04-31T09:00:00Z',
      '0000-01-01T09:00:00Z',
      '2028-02-29T09:00:00',
      '2028-02-29',
      'not-a-date',
      1780000000000,
      null,
    ]) {
      const response = await post({ ...base, startsAt: invalid });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid_request');
    }
    expect(createManual).not.toHaveBeenCalled();
  });

  it('forwards valid leap-day and offset instants as Date objects', async () => {
    const response = await post(base);
    expect(response.status).toBe(201);
    expect(createManual).toHaveBeenCalledTimes(1);
    const input = createManual.mock.calls[0]![1] as {
      startsAt: Date;
      endsAt: Date;
    };
    expect(input.startsAt).toBeInstanceOf(Date);
    expect(input.startsAt.toISOString()).toBe('2028-02-29T09:00:00.000Z');
    expect(input.endsAt.toISOString()).toBe('2028-02-29T10:00:00.000Z');
  });
});
