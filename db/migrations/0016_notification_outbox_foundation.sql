CREATE TYPE notification_outbox_state AS ENUM (
  'pending',
  'superseded'
);

CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  queue_entry_id uuid,
  logical_target_key text NOT NULL CHECK (length(btrim(logical_target_key)) BETWEEN 1 AND 160),
  event_key text NOT NULL CHECK (length(btrim(event_key)) BETWEEN 1 AND 120),
  intent_version bigint NOT NULL CHECK (intent_version > 0),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
  state notification_outbox_state NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  superseded_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  FOREIGN KEY (queue_entry_id, clinic_id)
    REFERENCES queue_entries(id, clinic_id) ON DELETE RESTRICT,
  FOREIGN KEY (superseded_by_id)
    REFERENCES notification_outbox(id) ON DELETE RESTRICT,
  UNIQUE (clinic_id, idempotency_key),
  UNIQUE (clinic_id, logical_target_key, event_key, intent_version),
  CHECK (
    (state = 'pending' AND superseded_at IS NULL AND superseded_by_id IS NULL)
    OR
    (state = 'superseded' AND superseded_at IS NOT NULL AND superseded_by_id IS NOT NULL)
  )
);

CREATE INDEX notification_outbox_pending_target_idx
  ON notification_outbox (clinic_id, logical_target_key, event_key, intent_version DESC)
  WHERE state = 'pending';

CREATE INDEX notification_outbox_queue_entry_idx
  ON notification_outbox (clinic_id, queue_entry_id, created_at DESC)
  WHERE queue_entry_id IS NOT NULL;
