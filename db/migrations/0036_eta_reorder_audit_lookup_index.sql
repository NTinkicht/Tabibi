-- tabibi:no-transaction
-- Restartable online index build: PostgreSQL leaves invalid indexes after
-- interrupted CREATE INDEX CONCURRENTLY. A repeated migration safely drops
-- any orphaned index before rebuilding it without a blocking table lock.
DROP INDEX CONCURRENTLY IF EXISTS audit_events_eta_reorder_session_idx;
CREATE INDEX CONCURRENTLY audit_events_eta_reorder_session_idx
  ON audit_events (clinic_id, (metadata->>'sessionId'))
  WHERE action = 'queue_entry.reordered';
