import { describe, expect, it } from 'vitest';
import { GET, POST } from '@/app/api/clinics/[clinicId]/sessions/route';
import { POST as delayPost } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/delay/route';

describe('session operations HTTP boundary', () => {
  it('rejects unauthenticated enumeration without accessing clinic data', async () => {
    process.env.STAFF_SESSION_SECRET =
      'test-secret-that-is-at-least-32-characters';
    const response = await GET(
      new Request(
        'http://localhost/api/clinics/00000000-0000-0000-0000-000000000000/sessions?date=2026-09-06',
      ),
      {
        params: Promise.resolve({
          clinicId: '00000000-0000-0000-0000-000000000000',
        }),
      },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: 'authentication_required',
    });
  });
  it('rejects cross-site mutations before parsing or touching persistence', async () => {
    const response = await POST(
      new Request(
        'http://localhost/api/clinics/00000000-0000-0000-0000-000000000000/sessions',
        {
          method: 'POST',
          headers: { origin: 'https://evil.example' },
          body: '{}',
        },
      ),
      {
        params: Promise.resolve({
          clinicId: '00000000-0000-0000-0000-000000000000',
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'csrf_rejected' });
  });
  it('rejects unauthenticated delay mutations before touching persistence', async () => {
    process.env.STAFF_SESSION_SECRET =
      'test-secret-that-is-at-least-32-characters';
    const response = await delayPost(
      new Request(
        'http://localhost/api/clinics/00000000-0000-0000-0000-000000000000/sessions/10000000-0000-0000-0000-000000000000/delay',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://localhost',
          },
          body: JSON.stringify({
            command: 'declare_delay',
            minutes: 10,
            expectedVersion: 0,
          }),
        },
      ),
      {
        params: Promise.resolve({
          clinicId: '00000000-0000-0000-0000-000000000000',
          sessionId: '10000000-0000-0000-0000-000000000000',
        }),
      },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: 'authentication_required',
    });
  });
});
