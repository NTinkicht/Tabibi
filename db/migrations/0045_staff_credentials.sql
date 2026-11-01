-- TAB-P0-01 (#723): local staff credentials, no external identity provider.
-- Only a salted scrypt hash is stored, together with the scrypt parameters used,
-- so parameters can be raised later without invalidating existing hashes.
-- failed_attempts and locked_until implement a time-bounded lockout that is
-- updated atomically in a single statement, so parallel guesses cannot bypass it.
CREATE TABLE staff_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash bytea NOT NULL CHECK (length(password_hash) = 32),
  salt bytea NOT NULL CHECK (length(salt) >= 16),
  scrypt_n integer NOT NULL CHECK (scrypt_n >= 16384),
  scrypt_r integer NOT NULL CHECK (scrypt_r >= 8),
  scrypt_p integer NOT NULL CHECK (scrypt_p >= 1),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
