ALTER TABLE notification_outbox
  DROP CONSTRAINT notification_outbox_check,
  DROP CONSTRAINT notification_outbox_dispatch_claim_check;

DROP INDEX notification_outbox_pending_target_idx;
DROP INDEX notification_outbox_dispatch_claim_eligible_idx;

ALTER TABLE notification_outbox ALTER COLUMN state DROP DEFAULT;
ALTER TYPE notification_outbox_state RENAME TO notification_outbox_state_wu20;
CREATE TYPE notification_outbox_state AS ENUM (
  'pending', 'failed', 'unknown', 'delivered', 'dead_letter', 'superseded'
);
ALTER TABLE notification_outbox
  ALTER COLUMN state TYPE notification_outbox_state USING state::text::notification_outbox_state,
  ALTER COLUMN state SET DEFAULT 'pending';
DROP TYPE notification_outbox_state_wu20;

ALTER TABLE notification_outbox
  ADD COLUMN dispatch_attempt_count integer NOT NULL DEFAULT 0
    CHECK (dispatch_attempt_count >= 0),
  ADD COLUMN dispatch_last_attempt_at timestamptz,
  ADD COLUMN dispatch_outcome_at timestamptz,
  ADD COLUMN dispatch_outcome_code text
    CHECK (
      dispatch_outcome_code IS NULL
      OR length(btrim(dispatch_outcome_code)) BETWEEN 1 AND 160
    );

ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_lifecycle_check
  CHECK (
    (state IN ('pending', 'failed', 'unknown')
      AND superseded_at IS NULL AND superseded_by_id IS NULL)
    OR
    (state = 'superseded'
      AND superseded_at IS NOT NULL AND superseded_by_id IS NOT NULL)
    OR
    (state IN ('delivered', 'dead_letter')
      AND superseded_at IS NULL AND superseded_by_id IS NULL)
  ),
  ADD CONSTRAINT notification_outbox_dispatch_claim_check
  CHECK (
    (
      dispatch_claim_token IS NULL
      AND dispatch_claimed_at IS NULL
      AND dispatch_claim_expires_at IS NULL
    )
    OR
    (
      state IN ('pending', 'failed', 'unknown')
      AND dispatch_claim_token IS NOT NULL
      AND dispatch_claimed_at IS NOT NULL
      AND dispatch_claim_expires_at IS NOT NULL
      AND dispatch_claim_expires_at > dispatch_claimed_at
    )
  ),
  ADD CONSTRAINT notification_outbox_dispatch_outcome_check
  CHECK (
    (state = 'pending'
      AND dispatch_outcome_at IS NULL AND dispatch_outcome_code IS NULL)
    OR
    (state IN ('failed', 'unknown', 'delivered', 'dead_letter')
      AND dispatch_attempt_count > 0 AND dispatch_last_attempt_at IS NOT NULL
      AND dispatch_outcome_at IS NOT NULL)
    OR
    (state = 'superseded')
  );

CREATE INDEX notification_outbox_pending_target_idx
  ON notification_outbox (clinic_id, logical_target_key, event_key, intent_version DESC)
  WHERE state IN ('pending', 'failed', 'unknown');

CREATE INDEX notification_outbox_dispatch_claim_eligible_idx
  ON notification_outbox (clinic_id, created_at, id)
  WHERE state IN ('pending', 'failed', 'unknown');
