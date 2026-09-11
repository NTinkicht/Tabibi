ALTER TABLE notification_outbox
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN dispatch_max_attempts integer NOT NULL DEFAULT 5
    CHECK (dispatch_max_attempts BETWEEN 1 AND 10);

CREATE OR REPLACE FUNCTION notification_outbox_apply_retry_budget()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state = 'failed' THEN
    NEW.dispatch_max_attempts := LEAST(NEW.dispatch_max_attempts, 5);
    IF NEW.dispatch_attempt_count >= NEW.dispatch_max_attempts THEN
      NEW.state := 'dead_letter';
      NEW.next_attempt_at := NULL;
    END IF;
  ELSIF NEW.state = 'unknown' THEN
    NEW.dispatch_max_attempts := LEAST(NEW.dispatch_max_attempts, 4);
    IF NEW.dispatch_attempt_count >= NEW.dispatch_max_attempts THEN
      NEW.state := 'dead_letter';
      NEW.next_attempt_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_outbox_retry_budget_guard
BEFORE INSERT OR UPDATE OF state, dispatch_attempt_count, next_attempt_at, dispatch_max_attempts
ON notification_outbox
FOR EACH ROW
EXECUTE FUNCTION notification_outbox_apply_retry_budget();

UPDATE notification_outbox
SET dispatch_max_attempts = CASE
      WHEN state = 'unknown' THEN 4
      ELSE 5
    END,
    next_attempt_at = CASE
      WHEN state = 'unknown' AND dispatch_attempt_count < 4
        THEN COALESCE(dispatch_last_attempt_at, dispatch_outcome_at, created_at, now())
      WHEN state = 'failed' AND dispatch_attempt_count < 5
        THEN COALESCE(dispatch_last_attempt_at, dispatch_outcome_at, created_at, now())
      ELSE NULL
    END
WHERE state IN ('failed', 'unknown');

ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_retry_schedule_check
  CHECK (
    next_attempt_at IS NULL
    OR (
      state IN ('failed', 'unknown')
      AND dispatch_attempt_count < dispatch_max_attempts
    )
  ) NOT VALID;
