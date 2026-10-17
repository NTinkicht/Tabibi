-- tabibi:no-transaction
-- #606 / PR #616: the eta-uncertainty/v1 priority-change signal reads
-- `queue_entry.reordered` audit events for ONE session on every guest live
-- status poll and receptionist snapshot. audit_events is only indexed by
-- (clinic_id, occurred_at), so that lookup would scan the clinic's whole
-- audit history. This partial expression index bounds it to the reorder
-- events of the requested session. Built concurrently so audited writes are
-- not blocked. The leading DROP recovers from an interrupted (invalid) build.
-- (This runner splits non-transactional files on semicolons: keep comments
-- free of them.)

DROP INDEX CONCURRENTLY IF EXISTS audit_events_queue_reorder_session_idx;

CREATE INDEX CONCURRENTLY audit_events_queue_reorder_session_idx
  ON audit_events (clinic_id, (metadata->>'sessionId'))
  WHERE action = 'queue_entry.reordered';
