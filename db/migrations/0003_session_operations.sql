ALTER TABLE consultation_sessions
  ADD COLUMN opened_at timestamptz,
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN declared_delay_minutes integer,
  ADD COLUMN delay_version integer NOT NULL DEFAULT 0,
  ADD COLUMN delay_updated_at timestamptz,
  ADD COLUMN delay_updated_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT consultation_sessions_delay_positive
    CHECK (declared_delay_minutes IS NULL OR declared_delay_minutes > 0),
  ADD CONSTRAINT consultation_sessions_delay_consistent
    CHECK ((declared_delay_minutes IS NULL) = (delay_updated_at IS NULL));

CREATE TABLE session_command_receipts (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, actor_user_id, idempotency_key)
);

CREATE INDEX session_command_receipts_created_idx
  ON session_command_receipts (created_at);
