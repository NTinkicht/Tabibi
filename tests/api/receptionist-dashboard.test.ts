import { describe, expect, it } from 'vitest';
import { GET } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/dashboard/route';

describe('receptionist dashboard HTTP boundary', () => {
  it('rejects unauthenticated private dashboard reads', async () => {
    process.env.STAFF_SESSION_SECRET =
      'dashboard-api-test-secret-at-least-32-characters';
    const nil = '00000000-0000-0000-0000-000000000000';
    const response = await GET(
      new Request(
        `http://localhost/api/clinics/${nil}/sessions/${nil}/dashboard`,
      ),
      { params: Promise.resolve({ clinicId: nil, sessionId: nil }) },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: 'authentication_required',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
