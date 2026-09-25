-- WU171: clinic-configured grace for explicit appointment-only waiting no-show.
-- This never turns a waiting walk-in/guest into an automatic no-show.
ALTER TABLE clinics
  ADD COLUMN appointment_arrival_grace_minutes integer NOT NULL DEFAULT 15
    CHECK (appointment_arrival_grace_minutes BETWEEN 0 AND 1440);

CREATE TABLE appointment_bulk_no_show_receipts (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
  session_id uuid NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, actor_user_id, idempotency_key),
  FOREIGN KEY (session_id, clinic_id)
    REFERENCES consultation_sessions(id, clinic_id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(response) = 'object')
);
