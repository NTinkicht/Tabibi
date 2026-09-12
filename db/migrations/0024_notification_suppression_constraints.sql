ALTER TABLE notification_outbox
  DROP CONSTRAINT notification_outbox_lifecycle_check,
  DROP CONSTRAINT notification_outbox_dispatch_outcome_check;

ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_lifecycle_check
  CHECK (
    (state IN ('pending', 'failed', 'unknown')
      AND superseded_at IS NULL AND superseded_by_id IS NULL)
    OR
    (state = 'superseded'
      AND superseded_at IS NOT NULL AND superseded_by_id IS NOT NULL)
    OR
    (state IN ('delivered', 'dead_letter', 'suppressed')
      AND superseded_at IS NULL AND superseded_by_id IS NULL)
  ),
  ADD CONSTRAINT notification_outbox_dispatch_outcome_check
  CHECK (
    (state = 'pending'
      AND dispatch_outcome_at IS NULL AND dispatch_outcome_code IS NULL)
    OR
    (state IN ('failed', 'unknown', 'delivered', 'dead_letter', 'suppressed')
      AND dispatch_attempt_count > 0 AND dispatch_last_attempt_at IS NOT NULL
      AND dispatch_outcome_at IS NOT NULL)
    OR
    (state = 'superseded')
  );
