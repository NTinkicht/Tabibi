import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  RATE_LIMIT_BUCKET_RETENTION_MS,
  purgeStaleSignInRateLimitBuckets,
} from '@/modules/identity/rate-limit-retention';
import { consumeSignInBudget } from '@/platform/http/sign-in-rate-limit';

// TAB-P0-15: stale sign-in throttling buckets are purged; live ones never are.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const NOW = new Date('2026-06-01T12:00:00Z');
const HOUR = 60 * 60 * 1_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const addBucket = (key: string, startedAgo: number, count = 1) =>
  pool.query(
    `INSERT INTO staff_sign_in_rate_limit_buckets
       (bucket_key, window_started_at, request_count, updated_at)
     VALUES ($1, $2, $3, $2)`,
    [key, ago(startedAgo), count],
  );
const keys = async () =>
  (
    await pool.query<{ bucket_key: string }>(
      'SELECT bucket_key FROM staff_sign_in_rate_limit_buckets ORDER BY bucket_key',
    )
  ).rows.map((r) => r.bucket_key);

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  await pool.query('TRUNCATE staff_sign_in_rate_limit_buckets');
});
afterAll(async () => {
  await pool.end();
});

describe('sign-in rate-limit bucket retention', () => {
  it('deletes buckets older than the grace and keeps those inside it', async () => {
    await addBucket('old', RATE_LIMIT_BUCKET_RETENTION_MS + HOUR);
    await addBucket('at-cutoff', RATE_LIMIT_BUCKET_RETENTION_MS);
    await addBucket('recent', RATE_LIMIT_BUCKET_RETENTION_MS - HOUR);
    await addBucket('exhausted-live', 60_000, 50);
    expect(await purgeStaleSignInRateLimitBuckets(pool, NOW)).toBe(2);
    expect(await keys()).toEqual(['exhausted-live', 'recent']);
  });

  it('does not weaken throttling: a live exhausted bucket still refuses, a purged one restarts', async () => {
    const live = `live-${Date.now()}`;
    const stale = `stale-${Date.now()}`;
    for (let i = 0; i < 3; i += 1) {
      expect(await consumeSignInBudget(live, 3)).toBe(true);
    }
    // Positive control: the exhausted bucket refuses before the purge.
    expect(await consumeSignInBudget(live, 3)).toBe(false);
    await addBucket(stale, RATE_LIMIT_BUCKET_RETENTION_MS + HOUR, 99);
    // The real clock is later than NOW, so the live bucket is inside the grace.
    const purged = await purgeStaleSignInRateLimitBuckets(pool, new Date());
    expect(purged).toBe(1);
    expect(await keys()).toEqual([live]);
    expect(await consumeSignInBudget(live, 3)).toBe(false);
    expect(await consumeSignInBudget(stale, 3)).toBe(true);
    const row = await pool.query(
      'SELECT request_count FROM staff_sign_in_rate_limit_buckets WHERE bucket_key=$1',
      [stale],
    );
    expect(row.rows[0].request_count).toBe(1);
  });

  it('purges one bounded batch per call and drains the rest on the next', async () => {
    await pool.query(
      `INSERT INTO staff_sign_in_rate_limit_buckets (bucket_key, window_started_at, request_count)
       SELECT 'bulk-' || g, $1, 1 FROM generate_series(1, 503) g`,
      [ago(RATE_LIMIT_BUCKET_RETENTION_MS + HOUR)],
    );
    expect(await purgeStaleSignInRateLimitBuckets(pool, NOW)).toBe(500);
    expect(await purgeStaleSignInRateLimitBuckets(pool, NOW)).toBe(3);
    expect(await keys()).toEqual([]);
  });
});
