ALTER TABLE notification_outbox
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN dispatch_max_attempts integer NOT NULL DEFAULT 3
    CHECK (dispatch_max_attempts BETWEEN 1 AND 10);

ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_retry_schedule_check
  CHECK (
    next_attempt_at IS NULL
    OR (
      state IN ('failed', 'unknown')
      AND dispatch_attempt_count < dispatch_max_attempts
    )
  ) NOT VALID;
