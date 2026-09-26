import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/appointments/bulk-no-show/route';

const clinicId = '00000000-0000-4000-8000-000000000000';
const sessionId = '11111111-1111-4111-8111-111111111111';
const url = `http://localhost/api/clinics/${clinicId}/sessions/${sessionId}/appointments/bulk-no-show`;
const context = {
  params: Promise.resolve({ clinicId, sessionId }),
};

describe('WU171 bulk no-show HTTP security boundary', () => {
  it('rejects cross-site mutation before auth, input or persistence', async () => {
    const response = await POST(
      new Request(url, {
        method: 'POST',
        headers: {
          origin: 'https://untrusted.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'A fake request' }),
      }),
      context,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'csrf_rejected',
    });
  });

  it('rejects unauthenticated no-show before visiting a clinic session', async () => {
    process.env.STAFF_SESSION_SECRET =
      'test-secret-that-is-at-least-32-characters';
    const response = await POST(
      new Request(url, {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
          'idempotency-key': 'wu171-no-auth',
        },
        body: JSON.stringify({ reason: 'Absent at the clinic' }),
      }),
      context,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: 'authentication_required',
    });
  });
});
