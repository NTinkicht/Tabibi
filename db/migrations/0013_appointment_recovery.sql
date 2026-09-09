CREATE TABLE appointment_recovery_receipts (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  appointment_id uuid NOT NULL,
  command text NOT NULL CHECK (command IN ('restore', 'restore_and_check_in', 'transfer')),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, actor_user_id, idempotency_key),
  FOREIGN KEY (appointment_id, clinic_id)
    REFERENCES appointments(id, clinic_id) ON DELETE CASCADE
);

CREATE INDEX appointment_recovery_receipts_appointment_idx
  ON appointment_recovery_receipts (appointment_id, created_at DESC);
