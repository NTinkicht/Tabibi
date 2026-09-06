ALTER TABLE consultation_sessions
  ADD COLUMN opened_at timestamptz,
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancellation_reason text,
  ADD COLUMN delay_minutes numeric,
  ADD COLUMN delay_updated_at timestamptz;

UPDATE consultation_sessions
   SET cancellation_reason = 'pre-operation-metadata migration'
 WHERE status = 'cancelled' AND cancellation_reason IS NULL;

ALTER TABLE consultation_sessions
  ADD CONSTRAINT consultation_sessions_delay_positive_ck
    CHECK (delay_minutes IS NULL OR delay_minutes > 0),
  ADD CONSTRAINT consultation_sessions_cancel_reason_ck
    CHECK (status <> 'cancelled' OR cancellation_reason IS NOT NULL);

CREATE TABLE session_operation_receipts (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES consultation_sessions(id) ON DELETE RESTRICT,
  command text NOT NULL,
  request_fingerprint text NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, idempotency_key)
);

CREATE INDEX session_operation_receipts_session_idx
  ON session_operation_receipts (clinic_id, session_id, created_at DESC);
