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
  );

DROP INDEX notification_outbox_dispatch_claim_eligible_idx;

CREATE INDEX notification_outbox_dispatch_claim_eligible_idx
  ON notification_outbox (clinic_id, next_attempt_at, created_at, id)
  WHERE state IN ('pending', 'failed', 'unknown');
