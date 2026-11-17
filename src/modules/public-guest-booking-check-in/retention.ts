import type { Pool } from 'pg';

// TAB-P0-15 data retention: public_guest_check_in_operations is the idempotency
// ledger of the booking-origin guest check-in. It is only consulted after the
// credential itself verified as live (not revoked, not expired; credentials live
// at most 24 hours), so the rows of a dead credential can never be replayed and
// are only retained data. guest_credentials are not purged (booking receipts
// reference them), so nothing else would ever delete these rows. A row is kept
// until its credential has been expired or revoked for the retention period.
export const CHECK_IN_OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PURGE_BATCH = 500;

/**
 * Deletes at most one bounded batch of operations whose credential stopped being
 * usable at least the retention period ago; rows locked by a concurrent check-in
 * are skipped for the next run. Returns the number of rows deleted.
 */
export async function purgeExpiredGuestCheckInOperations(
  pool: Pool,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - CHECK_IN_OPERATION_RETENTION_MS);
  const result = await pool.query(
    `DELETE FROM public_guest_check_in_operations operation
      WHERE (operation.credential_id, operation.operation_id) IN (
        SELECT o.credential_id, o.operation_id
          FROM public_guest_check_in_operations o
          JOIN guest_credentials c ON c.id = o.credential_id
         WHERE LEAST(c.expires_at, COALESCE(c.revoked_at, c.expires_at)) <= $1
         ORDER BY o.credential_id, o.operation_id
         LIMIT $2
           FOR UPDATE OF o SKIP LOCKED)`,
    [cutoff, PURGE_BATCH],
  );
  return result.rowCount ?? 0;
}
