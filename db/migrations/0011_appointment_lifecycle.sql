CREATE TABLE appointment_lifecycle_receipts (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
  appointment_id uuid NOT NULL,
  command text NOT NULL CHECK (command IN ('check_in', 'cancel')),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, actor_user_id, idempotency_key),
  FOREIGN KEY (appointment_id, clinic_id)
    REFERENCES appointments(id, clinic_id) ON DELETE RESTRICT
);

CREATE INDEX appointment_lifecycle_receipts_appointment_idx
  ON appointment_lifecycle_receipts (clinic_id, appointment_id, created_at);
