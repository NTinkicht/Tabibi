-- TAB-P1-01 slice 2: server-revocable patient sessions, separate from
-- staff_sessions so a patient session can never authenticate a staff route and
-- vice versa. Only the SHA-256 verifier of the random session identifier is
-- stored, never the identifier or the signed token. Logout sets revoked_at.
CREATE TABLE patient_sessions (
  verifier bytea PRIMARY KEY CHECK (length(verifier) = 32),
  user_id uuid NOT NULL REFERENCES patient_credentials(user_id) ON DELETE CASCADE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE INDEX patient_sessions_user_idx ON patient_sessions (user_id);
