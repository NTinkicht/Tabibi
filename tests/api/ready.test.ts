import { describe, expect, it } from 'vitest';
import { createReadyHandler } from '@/app/api/ready/route';

describe('GET /api/ready', () => {
  it('reports readiness when PostgreSQL responds', async () => {
    const response = await createReadyHandler(async () => true)(
      new Request('http://localhost/api/ready'),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ready' });
  });

  it('reports service unavailable when PostgreSQL does not respond', async () => {
    const response = await createReadyHandler(async () => false)(
      new Request('http://localhost/api/ready'),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'not_ready' });
  });
});
