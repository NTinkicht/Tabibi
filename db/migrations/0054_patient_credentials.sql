-- TAB-P1-01 (#875): local patient credentials, separate from staff_credentials.
-- A patient account is a users row whose auth_subject is the namespaced
-- 'patient:<normalized email>', so patient_dependents ownership keeps working and
-- a patient subject can never equal a staff subject. Only a salted scrypt hash and
-- its parameters are stored. failed_attempts and locked_until are updated
-- atomically in one statement by the service, like staff_credentials.
CREATE TABLE patient_credentials (
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

COMMENT ON TABLE patient_credentials IS
  'Patient account password credentials (scrypt hash only); never shared with staff_credentials.';
