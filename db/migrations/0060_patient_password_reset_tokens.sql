-- TAB-P1-01 slice 5 (#909): patient password recovery tokens. Only the SHA-256
-- verifier of the random token is stored, never the token itself. A token is
-- single use (used_at) and short lived (expires_at). Deleting the patient
-- credential removes its tokens.
CREATE TABLE patient_password_reset_tokens (
  verifier bytea PRIMARY KEY CHECK (length(verifier) = 32),
  user_id uuid NOT NULL REFERENCES patient_credentials(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX patient_password_reset_tokens_user_idx
  ON patient_password_reset_tokens (user_id);
