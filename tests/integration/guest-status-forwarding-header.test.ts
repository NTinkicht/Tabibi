import { Pool } from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/guest/status/route';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query('TRUNCATE guest_status_rate_limit_buckets');
});

describe('WU17 guest status trusted ingress boundary', () => {
  it('does not let spoofed forwarding headers create independent pre-auth buckets', async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await GET(
        new Request('http://localhost/api/guest/status', {
          headers: {
            'cf-connecting-ip': `198.51.100.${attempt + 1}`,
            'x-real-ip': `203.0.113.${attempt + 1}`,
            'x-forwarded-for': `192.0.2.${attempt + 1}, 10.0.0.1`,
          },
        }),
      );
      expect(response.status).toBe(401);
    }

    const limited = await GET(
      new Request('http://localhost/api/guest/status', {
        headers: {
          'cf-connecting-ip': '198.51.100.250',
          'x-real-ip': '203.0.113.250',
          'x-forwarded-for': '192.0.2.250',
        },
      }),
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');

    const buckets = await pool.query<{ count: string }>(
      'SELECT count(*)::text count FROM guest_status_rate_limit_buckets',
    );
    expect(buckets.rows[0]?.count).toBe('1');
  });
});
