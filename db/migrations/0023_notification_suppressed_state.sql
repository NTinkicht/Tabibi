-- tabibi:no-transaction

ALTER TYPE notification_outbox_state
  ADD VALUE IF NOT EXISTS 'suppressed';
