import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  GUEST_RATE_LIMIT_BUCKET_RETENTION_MS,
  purgeStaleGuestRateLimitBuckets,
} from '@/modules/guest-access/rate-limit-retention';
import { consumeGuestPushBucket } from '@/modules/guest-push/rate-limit';
import { runRetentionSweep } from '@/modules/maintenance/retention-sweep';

// TAB-P0-15: stale guest throttling buckets are purged from both tables; live
// ones never are, so throttling is not weakened.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const NOW = new Date('2026-06-01T12:00:00Z');
const HOUR = 60 * 60 * 1_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const TABLES = [
  'guest_status_rate_limit_buckets',
  'guest_push_rate_limit_buckets',
] as const;

const addBucket = (
  table: (typeof TABLES)[number],
  key: string,
  startedAgo: number,
  count = 1,
) =>
  pool.query(
    `INSERT INTO ${table} (bucket_key, window_started_at, request_count, updated_at)
     VALUES ($1, $2, $3, $2)`,
    [key, ago(startedAgo), count],
  );
const keys = async (table: (typeof TABLES)[number]) =>
  (
    await pool.query<{ bucket_key: string }>(
      `SELECT bucket_key FROM ${table} ORDER BY bucket_key`,
    )
  ).rows.map((r) => r.bucket_key);

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  for (const table of TABLES) await pool.query(`TRUNCATE ${table}`);
});
afterAll(async () => {
  await pool.end();
});

describe('guest throttling bucket retention', () => {
  it.each(TABLES)(
    'deletes %s rows older than the grace and keeps those inside it',
    async (table) => {
      await addBucket(
        table,
        'old',
        GUEST_RATE_LIMIT_BUCKET_RETENTION_MS + HOUR,
      );
      await addBucket(table, 'at-cutoff', GUEST_RATE_LIMIT_BUCKET_RETENTION_MS);
      await addBucket(
        table,
        'recent',
        GUEST_RATE_LIMIT_BUCKET_RETENTION_MS - HOUR,
      );
      await addBucket(table, 'exhausted-live', 60_000, 50);
      expect(await purgeStaleGuestRateLimitBuckets(pool, NOW)).toBe(2);
      expect(await keys(table)).toEqual(['exhausted-live', 'recent']);
    },
  );

  it('counts rows from both tables and leaves the other table alone', async () => {
    const stale = GUEST_RATE_LIMIT_BUCKET_RETENTION_MS + HOUR;
    await addBucket(TABLES[0], 'status-old', stale);
    await addBucket(TABLES[1], 'push-old', stale);
    await addBucket(TABLES[1], 'push-live', 60_000);
    expect(await purgeStaleGuestRateLimitBuckets(pool, NOW)).toBe(2);
    expect(await keys(TABLES[0])).toEqual([]);
    expect(await keys(TABLES[1])).toEqual(['push-live']);
  });

  it('does not weaken throttling: a live exhausted bucket still refuses, a purged one restarts', async () => {
    const live = `live-${Date.now()}`;
    const stale = `stale-${Date.now()}`;
    for (let i = 0; i < 3; i += 1) {
      expect(await consumeGuestPushBucket(pool, live, 3)).toBe(true);
    }
    // Positive control: the exhausted bucket refuses before the purge.
    expect(await consumeGuestPushBucket(pool, live, 3)).toBe(false);
    const { createHash } = await import('node:crypto');
    const digest = (k: string) => createHash('sha256').update(k).digest('hex');
    await pool.query(
      `INSERT INTO guest_push_rate_limit_buckets
         (bucket_key, window_started_at, request_count, updated_at)
       VALUES ($1, now() - interval '3 days', 99, now() - interval '3 days')`,
      [digest(stale)],
    );
    expect(await purgeStaleGuestRateLimitBuckets(pool, new Date())).toBe(1);
    expect(await keys(TABLES[1])).toEqual([digest(live)]);
    expect(await consumeGuestPushBucket(pool, live, 3)).toBe(false);
    expect(await consumeGuestPushBucket(pool, stale, 3)).toBe(true);
  });

  it('is run by the retention sweep runner', async () => {
    await addBucket(
      TABLES[0],
      'sweep-old',
      GUEST_RATE_LIMIT_BUCKET_RETENTION_MS + HOUR,
    );
    await addBucket(TABLES[0], 'sweep-live', 60_000);
    const result = await runRetentionSweep(pool, NOW);
    expect(result.failed).toEqual([]);
    expect(result.deleted.guest_rate_limit).toBe(1);
    expect(await keys(TABLES[0])).toEqual(['sweep-live']);
  });
});
