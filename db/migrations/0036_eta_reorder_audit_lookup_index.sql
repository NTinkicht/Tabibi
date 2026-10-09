-- tabibi:no-transaction
-- Large append-only audit history must remain writable during index build.
-- Only committed priority audit rows are indexed; scanner is session-scoped.
CREATE INDEX CONCURRENTLY audit_events_eta_reorder_session_idx
  ON audit_events (clinic_id, (metadata->>'sessionId'))
  WHERE action = 'queue_entry.reordered';
