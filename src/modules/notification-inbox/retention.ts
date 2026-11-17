import type { Pool } from 'pg';

// TAB-P0-15 data retention: notification_inbox_items holds rendered patient-facing
// text (title and body) about a visit and nothing ever deleted a row. Visit-scoped
// messages only matter during and shortly after the clinic day, so rows older than
// the grace are deleted whether read or unread. Account-scoped rows are never purged
// here: account history is a separate, not yet approved, policy (TAB-P1-04).
export const VISIT_INBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const PURGE_BATCH = 500;

/**
 * Deletes at most one bounded batch of old visit-patient inbox rows per call; rows
 * locked by a concurrent read-state update are skipped for the next run. Returns
 * the number of rows deleted.
 */
export async function purgeExpiredVisitInboxItems(
  pool: Pool,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - VISIT_INBOX_RETENTION_MS);
  const result = await pool.query(
    `DELETE FROM notification_inbox_items WHERE id IN (
       SELECT id FROM notification_inbox_items
        WHERE subject_kind = 'visit_patient' AND created_at <= $1
        ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    [cutoff, PURGE_BATCH],
  );
  return result.rowCount ?? 0;
}
