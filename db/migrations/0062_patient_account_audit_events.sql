-- #971 (SECURITY.md Auditability): patient accounts are platform-level, so their
-- credential events cannot use the clinic-scoped audit_events table. This
-- append-only log records registration, sign-in and sign-out, session
-- revocation, lockout, password change, and operator-issued password reset
-- issuance and redemption. Each row is written by the same statement as the
-- change it records. Metadata never holds tokens, verifiers, passwords, hashes
-- or e-mail addresses. No product path deletes users; rows follow the account
-- and are purged by the retention sweep after the audit retention window.
CREATE TABLE patient_account_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_kind text NOT NULL CHECK (actor_kind IN ('patient', 'operator', 'system')),
  actor_label text CHECK (actor_label IS NULL OR length(actor_label) BETWEEN 1 AND 120),
  action text NOT NULL CHECK (action IN (
    'account_registered', 'signed_in', 'signed_out', 'sessions_revoked',
    'account_locked', 'password_changed', 'password_reset_issued',
    'password_reset_redeemed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((actor_kind = 'operator') = (actor_label IS NOT NULL))
);

CREATE INDEX patient_account_audit_events_user_time_idx
  ON patient_account_audit_events (user_id, occurred_at DESC);
CREATE INDEX patient_account_audit_events_time_idx
  ON patient_account_audit_events (occurred_at);

-- The lockout transition is recorded by a trigger because the failed-attempt
-- UPDATE cannot see the previous locked_until in RETURNING (PostgreSQL 16). It
-- fires only when an account moves from unlocked to locked, so repeated
-- failures while already locked add no rows.
CREATE FUNCTION patient_account_audit_lockout() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO patient_account_audit_events (user_id, actor_kind, action, metadata)
  VALUES (NEW.user_id, 'system', 'account_locked',
          jsonb_build_object('lockedUntil', NEW.locked_until,
                             'failedAttempts', NEW.failed_attempts));
  RETURN NULL;
END;
$$;

CREATE TRIGGER patient_credentials_audit_lockout
  AFTER UPDATE OF locked_until ON patient_credentials
  FOR EACH ROW
  WHEN (NEW.locked_until IS NOT NULL AND NEW.locked_until > now()
        AND (OLD.locked_until IS NULL OR OLD.locked_until <= now()))
  EXECUTE FUNCTION patient_account_audit_lockout();
