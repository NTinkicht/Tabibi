-- Mutable service order is deliberately separate from immutable registration
-- and arrival eligibility evidence. A session version supports explicit stale
-- command rejection while the session row serializes competing mutations.
ALTER TABLE consultation_sessions
  ADD COLUMN queue_order_version bigint NOT NULL DEFAULT 0
    CHECK (queue_order_version >= 0);

ALTER TABLE queue_entries
  ADD COLUMN service_order bigint CHECK (service_order IS NULL OR service_order > 0);

UPDATE queue_entries
   SET service_order = eligibility_order
 WHERE state = 'checked_in' AND eligibility_order IS NOT NULL;

CREATE UNIQUE INDEX queue_entries_session_service_order_uq
  ON queue_entries (session_id, service_order)
  WHERE service_order IS NOT NULL AND state = 'checked_in';

CREATE INDEX queue_entries_session_service_selection_idx
  ON queue_entries (session_id, state, service_order, eligibility_order);

CREATE TABLE queue_reorder_receipts (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
  session_id uuid NOT NULL,
  queue_entry_id uuid NOT NULL,
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, actor_user_id, idempotency_key),
  FOREIGN KEY (session_id, clinic_id)
    REFERENCES consultation_sessions(id, clinic_id) ON DELETE RESTRICT,
  FOREIGN KEY (queue_entry_id, clinic_id)
    REFERENCES queue_entries(id, clinic_id) ON DELETE RESTRICT
);
