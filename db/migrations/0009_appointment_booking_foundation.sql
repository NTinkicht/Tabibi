CREATE TYPE appointment_status AS ENUM (
  'booked',
  'confirmed',
  'checked_in',
  'completed',
  'cancelled',
  'no_show'
);

ALTER TABLE queue_entries
  DROP CONSTRAINT IF EXISTS queue_entries_source_check,
  ADD CONSTRAINT queue_entries_source_check
    CHECK (source IN ('walk_in', 'appointment'));

CREATE TABLE appointments (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  queue_entry_id uuid NOT NULL,
  status appointment_status NOT NULL DEFAULT 'confirmed',
  scheduled_start_at timestamptz NOT NULL,
  scheduled_end_at timestamptz NOT NULL,
  preferred_locale text NOT NULL CHECK (preferred_locale IN ('ar', 'fr')),
  contact_preference text NOT NULL DEFAULT 'none'
    CHECK (contact_preference IN ('none', 'phone', 'email')),
  source text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scheduled_end_at > scheduled_start_at),
  FOREIGN KEY (clinic_id, doctor_id)
    REFERENCES doctor_clinics(clinic_id, doctor_id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, clinic_id)
    REFERENCES consultation_sessions(id, clinic_id) ON DELETE RESTRICT,
  FOREIGN KEY (patient_id, clinic_id)
    REFERENCES patient_operational_records(id, clinic_id) ON DELETE RESTRICT,
  FOREIGN KEY (queue_entry_id, clinic_id)
    REFERENCES queue_entries(id, clinic_id) ON DELETE RESTRICT,
  UNIQUE (id, clinic_id),
  UNIQUE (queue_entry_id),
  UNIQUE (queue_entry_id, clinic_id)
);

CREATE INDEX appointments_clinic_session_status_idx
  ON appointments (clinic_id, session_id, status);
CREATE INDEX appointments_patient_time_idx
  ON appointments (clinic_id, patient_id, scheduled_start_at);

CREATE TABLE appointment_booking_receipts (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
  appointment_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, actor_user_id, idempotency_key),
  FOREIGN KEY (appointment_id, clinic_id)
    REFERENCES appointments(id, clinic_id) ON DELETE RESTRICT
);

CREATE FUNCTION synchronize_appointment_from_queue_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_status appointment_status;
BEGIN
  IF NEW.state = OLD.state OR NEW.source <> 'appointment' THEN
    RETURN NEW;
  END IF;

  target_status := CASE NEW.state
    WHEN 'waiting' THEN 'confirmed'::appointment_status
    WHEN 'checked_in' THEN 'checked_in'::appointment_status
    WHEN 'called' THEN 'checked_in'::appointment_status
    WHEN 'in_consultation' THEN 'checked_in'::appointment_status
    WHEN 'completed' THEN 'completed'::appointment_status
    WHEN 'cancelled' THEN 'cancelled'::appointment_status
    WHEN 'no_show' THEN 'no_show'::appointment_status
  END;

  UPDATE appointments
     SET status = target_status,
         updated_at = now()
   WHERE queue_entry_id = NEW.id
     AND clinic_id = NEW.clinic_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER queue_entries_appointment_state_sync
AFTER UPDATE OF state ON queue_entries
FOR EACH ROW
EXECUTE FUNCTION synchronize_appointment_from_queue_state();

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
      'appointment'
    ));
