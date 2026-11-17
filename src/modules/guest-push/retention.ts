import type { Pool } from 'pg';

// TAB-P0-15 data retention: a revoked or expired guest_push_subscriptions row
// keeps no sealed material, but it still links a keyed endpoint hash to a visit
// and nothing ever deleted it. Nothing reads a revoked row (every lookup filters
// `revoked_at IS NULL`), so it is only retained data. Active rows are never
// purged here: the expiry sweep revokes them first.
export const REVOKED_PUSH_BINDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PURGE_BATCH = 500;

/**
 * Deletes at most one bounded batch of bindings revoked at least the retention
 * period ago; rows locked by a concurrent transaction are skipped for the next
 * run. Returns the number of rows deleted.
 */
export async function purgeRevokedPushBindings(
  pool: Pool,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - REVOKED_PUSH_BINDING_RETENTION_MS);
  const result = await pool.query(
    `DELETE FROM guest_push_subscriptions WHERE id IN (
       SELECT id FROM guest_push_subscriptions
        WHERE revoked_at IS NOT NULL AND revoked_at <= $1
        ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    [cutoff, PURGE_BATCH],
  );
  return result.rowCount ?? 0;
}
