import { beforeEach, describe, expect, it, vi } from 'vitest';

type StaffAuthModule = typeof import('@/platform/http/staff-auth');

const book = vi.hoisted(() => vi.fn());
vi.mock('@/modules/appointment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/appointment')>();
  return {
    ...actual,
    AppointmentService: class {
      bookForExistingPatient(...args: unknown[]) {
        return book(...args);
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

import { POST } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/appointments/route';

const clinicId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000002';
const patientId = '00000000-0000-4000-8000-000000000003';
const url = `http://localhost/api/clinics/${clinicId}/sessions/${sessionId}/appointments`;
const context = () => ({ params: Promise.resolve({ clinicId, sessionId }) });
const base = {
  patientId,
  scheduledStartAt: '2028-02-29T09:00:00Z',
  scheduledEndAt: '2028-02-29T11:00:00+01:00',
  contactPreference: 'none',
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

describe('WU185 staff appointment instant ingress', () => {
  beforeEach(() => {
    book.mockReset();
    book.mockResolvedValue({ appointment: { id: 'created' } });
  });

  it('rejects normalized, ambiguous and coerced instants before booking/DB work', async () => {
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
      const response = await post({ ...base, scheduledStartAt: invalid });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid_request');
    }
    expect(book).not.toHaveBeenCalled();
  });

  it('passes valid leap-day and offset instants as Date objects', async () => {
    const response = await post(base);
    expect(response.status).toBe(201);
    expect(book).toHaveBeenCalledTimes(1);
    const input = book.mock.calls[0]![2] as {
      scheduledStartAt: Date;
      scheduledEndAt: Date;
    };
    expect(input.scheduledStartAt).toBeInstanceOf(Date);
    expect(input.scheduledStartAt.toISOString()).toBe(
      '2028-02-29T09:00:00.000Z',
    );
    expect(input.scheduledEndAt.toISOString()).toBe('2028-02-29T10:00:00.000Z');
  });
});
