ALTER TABLE consultation_sessions
  ADD COLUMN opened_at timestamptz,
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN delay_minutes double precision,
  ADD COLUMN delay_declared_at timestamptz,
  ADD COLUMN delay_declared_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT consultation_sessions_delay_positive_finite
    CHECK (delay_minutes IS NULL OR (delay_minutes > 0 AND delay_minutes < 'Infinity'::double precision));

-- Enables tenant-bound receipt references without weakening the globally unique id.
ALTER TABLE consultation_sessions ADD CONSTRAINT consultation_sessions_id_clinic_uq UNIQUE (id, clinic_id);

CREATE TABLE session_command_receipts (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  session_id uuid NOT NULL,
  command text NOT NULL CHECK (command IN ('open', 'pause', 'resume', 'close', 'cancel', 'delay.declare', 'delay.update', 'delay.clear')),
  fingerprint text NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, actor_user_id, idempotency_key),
  FOREIGN KEY (session_id, clinic_id) REFERENCES consultation_sessions(id, clinic_id) ON DELETE RESTRICT
);

CREATE INDEX session_command_receipts_session_idx ON session_command_receipts (clinic_id, session_id, created_at DESC);
