CREATE INDEX notification_outbox_dead_letter_observability_idx
  ON notification_outbox (clinic_id, dispatch_outcome_at DESC, id DESC)
  WHERE state = 'dead_letter';
