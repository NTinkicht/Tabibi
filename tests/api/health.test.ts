import { describe, expect, it } from 'vitest';
import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
  it('reports liveness and preserves a safe request ID', async () => {
    const response = await GET(
      new Request('http://localhost/api/health', {
        headers: { 'x-request-id': 'test-request-1' },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('test-request-1');
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'tabibi',
      requestId: 'test-request-1',
    });
  });
  it('replaces malformed request IDs', async () => {
    const response = await GET(
      new Request('http://localhost/api/health', {
        headers: { 'x-request-id': 'unsafe value' },
      }),
    );
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
