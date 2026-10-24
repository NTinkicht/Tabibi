-- TAB-P0-01 (#634, owner decision A): server-revocable staff sessions.
-- A signed staff token carries a random session identifier (sid). Only its
-- SHA-256 verifier is stored here, never the identifier or the token, so a
-- database read cannot mint or replay a session. Every staff route requires
-- an unrevoked, unexpired row bound to the signed subject. Logout sets
-- revoked_at, which immediately invalidates the token on every staff route.
CREATE TABLE staff_sessions (
  verifier bytea PRIMARY KEY CHECK (length(verifier) = 32),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE INDEX staff_sessions_user_idx ON staff_sessions (user_id);
