import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearerSignature } from '@/modules/guest-access';
import { withinPublicBookingBearerBudget } from '@/platform/http/public-booking-bearer-rate-limit';
import { migrate } from '../../scripts/db/lib';

function guestBearerFor(credentialId: string): string {
  return `${credentialId}.secret.${bearerSignature(credentialId, 'secret')}`;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

describe('public booking bearer rate limit (PostgreSQL)', () => {
  beforeAll(async () => {
    await migrate();
    await pool.query('TRUNCATE guest_status_rate_limit_buckets');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('allows exactly the credential limit per window, then refuses', async () => {
    const bearer = guestBearerFor('11111111-1111-4111-8111-111111111111');
    const results: boolean[] = [];
    for (let i = 0; i < 7; i += 1) {
      results.push(
        await withinPublicBookingBearerBudget(pool, 'check-in', bearer),
      );
    }
    expect(results).toEqual([true, true, true, true, true, true, false]);
  });

  it('keeps routes and credentials in separate budgets', async () => {
    const a = guestBearerFor('22222222-2222-4222-8222-222222222222');
    const b = guestBearerFor('33333333-3333-4333-8333-333333333333');
    for (let i = 0; i < 6; i += 1) {
      await withinPublicBookingBearerBudget(pool, 'cancel', a);
    }
    expect(await withinPublicBookingBearerBudget(pool, 'cancel', a)).toBe(
      false,
    );
    expect(await withinPublicBookingBearerBudget(pool, 'cancel', b)).toBe(true);
    expect(await withinPublicBookingBearerBudget(pool, 'status', a)).toBe(true);
  });

  it('starts a fresh window after expiry', async () => {
    const bearer = guestBearerFor('44444444-4444-4444-8444-444444444444');
    for (let i = 0; i < 6; i += 1) {
      await withinPublicBookingBearerBudget(pool, 'check-in', bearer);
    }
    expect(
      await withinPublicBookingBearerBudget(pool, 'check-in', bearer),
    ).toBe(false);
    await pool.query(
      `UPDATE guest_status_rate_limit_buckets
          SET window_started_at = now() - interval '61 seconds'`,
    );
    expect(
      await withinPublicBookingBearerBudget(pool, 'check-in', bearer),
    ).toBe(true);
  });

  it('bounds forged bearers by the shared untrusted bucket only', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 7; i += 1) {
      results.push(
        await withinPublicBookingBearerBudget(pool, 'status', `forged-${i}`),
      );
    }
    expect(results).toEqual([true, true, true, true, true, true, false]);
  });
});
