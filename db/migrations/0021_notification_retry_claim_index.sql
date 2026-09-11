-- tabibi:no-transaction

DROP INDEX CONCURRENTLY IF EXISTS notification_outbox_dispatch_claim_eligible_idx_wu23;

CREATE INDEX CONCURRENTLY notification_outbox_dispatch_claim_eligible_idx_wu23
  ON notification_outbox (clinic_id, next_attempt_at, created_at, id)
  WHERE state IN ('pending', 'failed', 'unknown');

DROP INDEX CONCURRENTLY IF EXISTS notification_outbox_dispatch_claim_eligible_idx;

ALTER INDEX notification_outbox_dispatch_claim_eligible_idx_wu23
  RENAME TO notification_outbox_dispatch_claim_eligible_idx;
