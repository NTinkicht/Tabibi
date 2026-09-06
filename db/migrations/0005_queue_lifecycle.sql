-- Reception queue lifecycle commands are serialized on their session row. These
-- constraints remain the final guard against two simultaneously active calls or
-- consultations even if a future caller bypasses the service.
CREATE UNIQUE INDEX queue_entries_one_called_per_session_uq
  ON queue_entries (session_id) WHERE state = 'called';
CREATE UNIQUE INDEX queue_entries_one_consultation_per_session_uq
  ON queue_entries (session_id) WHERE state = 'in_consultation';

CREATE TABLE queue_command_receipts (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
  queue_entry_id uuid NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, actor_user_id, idempotency_key),
  FOREIGN KEY (queue_entry_id, clinic_id)
    REFERENCES queue_entries(id, clinic_id) ON DELETE RESTRICT
);
