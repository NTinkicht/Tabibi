-- TAB-P1-07 (#727): single-use staff invites bound to one clinic, one email and
-- one role. Only a SHA-256 verifier of the secret is stored, never the token.
-- At most one open (not revoked, not accepted) invite exists per clinic and email.
CREATE TABLE staff_invites (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  role membership_role NOT NULL CHECK (role IN ('doctor', 'receptionist')),
  token_verifier bytea NOT NULL CHECK (length(token_verifier) = 32),
  invited_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  accepted_at timestamptz,
  accepted_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (revoked_at IS NULL OR accepted_at IS NULL),
  CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL))
);

CREATE UNIQUE INDEX staff_invites_one_open_per_email_idx
  ON staff_invites (clinic_id, email)
  WHERE revoked_at IS NULL AND accepted_at IS NULL;

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_entity_type_check,
  ADD CONSTRAINT audit_events_entity_type_check
    CHECK (entity_type IN (
      'clinic',
      'membership',
      'doctor',
      'schedule_template',
      'consultation_session',
      'queue_entry',
      'appointment',
      'staff_invite'
    ));
