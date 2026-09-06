CREATE TYPE queue_entry_status AS ENUM (
  'waiting',
  'checked_in',
  'called',
  'in_consultation',
  'completed',
  'cancelled',
  'no_show'
);

CREATE TABLE patient_operational_records (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  account_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  private_display_name text NOT NULL CHECK (length(btrim(private_display_name)) BETWEEN 1 AND 120),
  contact_phone text CHECK (contact_phone IS NULL OR length(contact_phone) BETWEEN 3 AND 32),
  contact_email text CHECK (contact_email IS NULL OR length(contact_email) BETWEEN 3 AND 254),
  preferred_locale text NOT NULL DEFAULT 'ar' CHECK (preferred_locale IN ('ar', 'fr')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, clinic_id)
);

CREATE UNIQUE INDEX consultation_sessions_id_clinic_uq
  ON consultation_sessions (id, clinic_id);

CREATE TABLE queue_entries (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL,
  session_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  state queue_entry_status NOT NULL DEFAULT 'waiting',
  source text NOT NULL DEFAULT 'walk_in' CHECK (source IN ('walk_in')),
  registration_order bigint NOT NULL CHECK (registration_order > 0),
  eligibility_order bigint CHECK (eligibility_order IS NULL OR eligibility_order > 0),
  priority_order bigint CHECK (priority_order IS NULL OR priority_order > 0),
  public_display_label text NOT NULL CHECK (length(public_display_label) BETWEEN 3 AND 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, clinic_id)
    REFERENCES consultation_sessions(id, clinic_id) ON DELETE RESTRICT,
  FOREIGN KEY (patient_id, clinic_id)
    REFERENCES patient_operational_records(id, clinic_id) ON DELETE RESTRICT,
  UNIQUE (id, clinic_id),
  UNIQUE (session_id, registration_order),
  UNIQUE (session_id, public_display_label)
);

CREATE UNIQUE INDEX queue_entries_session_eligibility_uq
  ON queue_entries (session_id, eligibility_order)
  WHERE eligibility_order IS NOT NULL;

CREATE UNIQUE INDEX queue_entries_session_priority_uq
  ON queue_entries (session_id, priority_order)
  WHERE priority_order IS NOT NULL;

CREATE INDEX queue_entries_session_state_order_idx
  ON queue_entries (session_id, state, registration_order);

CREATE TABLE queue_registration_receipts (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
  patient_id uuid NOT NULL,
  queue_entry_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, actor_user_id, idempotency_key),
  FOREIGN KEY (patient_id, clinic_id)
    REFERENCES patient_operational_records(id, clinic_id) ON DELETE RESTRICT,
  FOREIGN KEY (queue_entry_id, clinic_id)
    REFERENCES queue_entries(id, clinic_id) ON DELETE RESTRICT
);

-- Once queue rows exist, terminal session transitions must compose with them.
-- Registration and lifecycle mutation serialize through the locked session row;
-- this trigger is the database-level final guard for direct/update code paths too.
CREATE FUNCTION enforce_session_queue_terminal_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'closed' THEN
    IF EXISTS (
      SELECT 1
        FROM queue_entries
       WHERE session_id = NEW.id
         AND state IN ('waiting', 'checked_in', 'called', 'in_consultation')
    ) THEN
      RAISE EXCEPTION 'Cannot close a session while active queue entries remain'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'cancelled' THEN
    IF EXISTS (
      SELECT 1
        FROM queue_entries
       WHERE session_id = NEW.id
         AND state = 'in_consultation'
    ) THEN
      RAISE EXCEPTION 'Cannot cancel a session while a consultation is active'
        USING ERRCODE = '23514';
    END IF;

    UPDATE queue_entries
       SET state = 'cancelled',
           eligibility_order = NULL,
           priority_order = NULL,
           updated_at = now()
     WHERE session_id = NEW.id
       AND state IN ('waiting', 'checked_in', 'called');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER consultation_sessions_queue_terminal_guard
BEFORE UPDATE OF status ON consultation_sessions
FOR EACH ROW
EXECUTE FUNCTION enforce_session_queue_terminal_transition();

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_entity_type_check,
  ADD CONSTRAINT audit_events_entity_type_check
    CHECK (entity_type IN (
      'clinic',
      'membership',
      'doctor',
      'schedule_template',
      'consultation_session',
      'queue_entry'
    ));
