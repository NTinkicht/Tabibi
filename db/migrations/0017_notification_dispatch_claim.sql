ALTER TABLE notification_outbox
  ADD COLUMN dispatch_claim_token uuid,
  ADD COLUMN dispatch_claimed_at timestamptz,
  ADD COLUMN dispatch_claim_expires_at timestamptz;

ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_dispatch_claim_check
  CHECK (
    (
      dispatch_claim_token IS NULL
      AND dispatch_claimed_at IS NULL
      AND dispatch_claim_expires_at IS NULL
    )
    OR
    (
      state = 'pending'
      AND dispatch_claim_token IS NOT NULL
      AND dispatch_claimed_at IS NOT NULL
      AND dispatch_claim_expires_at IS NOT NULL
      AND dispatch_claim_expires_at > dispatch_claimed_at
    )
  );

CREATE UNIQUE INDEX notification_outbox_dispatch_claim_token_uq
  ON notification_outbox (dispatch_claim_token)
  WHERE dispatch_claim_token IS NOT NULL;

CREATE INDEX notification_outbox_dispatch_claim_eligible_idx
  ON notification_outbox (clinic_id, created_at, id)
  WHERE state = 'pending';
