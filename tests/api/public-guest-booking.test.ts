import { beforeEach, describe, expect, it, vi } from 'vitest';

const book = vi.fn();
const withinBudget = vi.fn();

vi.mock('@/platform/http/public-booking-rate-limit', () => ({
  PUBLIC_BOOKING_RETRY_AFTER_SECONDS: 900,
  withinPublicBookingBudget: (...args: unknown[]) => withinBudget(...args),
}));

vi.mock('@/modules/public-availability-selection', () => ({
  PublicAvailabilitySelectionService: class {},
}));

vi.mock('@/modules/public-guest-booking', () => ({
  PublicGuestBookingValidationError: class extends Error {},
  PublicGuestBookingRejectedError: class extends Error {},
  PublicGuestBookingService: class {
    book(...args: unknown[]) {
      return book(...args);
    }
  },
}));

vi.mock('@/platform/database/pool', () => ({ getPool: () => ({}) }));
vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import {
  PublicGuestBookingRejectedError,
  PublicGuestBookingValidationError,
} from '@/modules/public-guest-booking';
import { POST } from '@/app/api/public/bookings/route';

const validBody = {
  selectionReference: 'v1.opaque.selection.reference',
  privateDisplayName: 'Private Guest',
  contactPhone: '+213555010101',
  preferredLocale: 'fr' as const,
  contactPreference: 'phone' as const,
};

function request(
  body: unknown = validBody,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://tabibi.test/api/public/bookings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'wu59-route-idem-1',
      'x-request-id': 'wu59-route-request-1',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/public/bookings', () => {
  beforeEach(() => {
    book.mockReset();
    withinBudget.mockReset();
    withinBudget.mockResolvedValue(true);
    process.env.PUBLIC_AVAILABILITY_SELECTION_SECRET =
      'wu59-route-test-secret-that-is-deliberately-long-enough';
  });

  it('passes header context to the service and returns only the public booking result', async () => {
    book.mockResolvedValue({
      serviceDate: '2099-03-01',
      startsAt: '2099-03-01T08:00:00.000Z',
      endsAt: '2099-03-01T09:00:00.000Z',
      queueLabel: 'A-17',
      guestBearer: 'opaque-guest-bearer',
      guestAccessExpiresAt: '2099-03-02T00:00:00.000Z',
      internalClinicId: 'must-never-serialize',
    });

    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('wu59-route-request-1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(book).toHaveBeenCalledWith({
      ...validBody,
      idempotencyKey: 'wu59-route-idem-1',
      correlationId: 'wu59-route-request-1',
    });
    expect(await response.json()).toEqual({
      serviceDate: '2099-03-01',
      startsAt: '2099-03-01T08:00:00.000Z',
      endsAt: '2099-03-01T09:00:00.000Z',
      queueLabel: 'A-17',
      guestBearer: 'opaque-guest-bearer',
      guestAccessExpiresAt: '2099-03-02T00:00:00.000Z',
    });
  });

  it('answers 429 with retry-after and never books when the abuse budget is exhausted', async () => {
    withinBudget.mockResolvedValue(false);

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('900');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      status: 'rate_limited',
      requestId: 'wu59-route-request-1',
    });
    expect(book).not.toHaveBeenCalled();
    expect(withinBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionReference: validBody.selectionReference,
        contactPhone: validBody.contactPhone,
      }),
    );
  });

  it('does not spend budget on malformed requests', async () => {
    await POST(request({ ...validBody, clinicId: 'private-id' }));
    expect(withinBudget).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies and unsafe idempotency keys before booking', async () => {
    const unsafeKey = await POST(
      request(validBody, { 'idempotency-key': 'guest@example.com' }),
    );
    expect(unsafeKey.status).toBe(400);
    expect(await unsafeKey.json()).toEqual({
      status: 'rejected',
      requestId: 'wu59-route-request-1',
    });

    const extraField = await POST(
      request({ ...validBody, clinicId: 'private-id' }),
    );
    expect(extraField.status).toBe(400);
    expect(await extraField.json()).toEqual({
      status: 'rejected',
      requestId: 'wu59-route-request-1',
    });
    expect(book).not.toHaveBeenCalled();
  });

  it('maps validation and authoritative rejection to the same non-oracular response', async () => {
    book.mockRejectedValueOnce(
      new PublicGuestBookingValidationError('private detail'),
    );
    const validation = await POST(request());

    book.mockRejectedValueOnce(new PublicGuestBookingRejectedError());
    const rejected = await POST(request());

    for (const response of [validation, rejected]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        status: 'rejected',
        requestId: 'wu59-route-request-1',
      });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('normalizes an unsafe supplied request id through the shared request context', async () => {
    book.mockResolvedValue({
      serviceDate: '2099-03-01',
      startsAt: '2099-03-01T08:00:00.000Z',
      endsAt: '2099-03-01T09:00:00.000Z',
      queueLabel: 'A-17',
      guestBearer: 'opaque-guest-bearer',
      guestAccessExpiresAt: '2099-03-02T00:00:00.000Z',
    });

    const response = await POST(
      request(validBody, { 'x-request-id': 'guest@example.com' }),
    );
    const generated = response.headers.get('x-request-id');

    expect(response.status).toBe(201);
    expect(generated).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(generated).not.toBe('guest@example.com');
    expect(book).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: generated }),
    );
  });
});
