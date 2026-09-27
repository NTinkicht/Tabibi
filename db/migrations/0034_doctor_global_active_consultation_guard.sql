-- WU192: enforce the doctor-global active-consultation invariant at the
-- database boundary without mixing advisory-lock and row-lock order.
--
-- A dedicated guard row keyed by doctor serializes every transition into
-- in_consultation, including direct/future SQL writers. PostgreSQL's unique
-- constraint performs the serialization without taking the application-level
-- doctor advisory lock after a queue row has already been locked, avoiding the
-- row-lock <-> advisory-lock deadlock identified during review.
CREATE TABLE doctor_active_consultations (
  doctor_id uuid PRIMARY KEY REFERENCES doctor_profiles(id) ON DELETE CASCADE,
  queue_entry_id uuid NOT NULL UNIQUE REFERENCES queue_entries(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Fail closed if historical data already violates the invariant.
INSERT INTO doctor_active_consultations (doctor_id, queue_entry_id)
SELECT session.doctor_id, entry.id
  FROM queue_entries entry
  JOIN consultation_sessions session
    ON session.id = entry.session_id
   AND session.clinic_id = entry.clinic_id
 WHERE entry.state = 'in_consultation';

CREATE FUNCTION sync_doctor_active_consultation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_doctor uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state = 'in_consultation' THEN
      DELETE FROM doctor_active_consultations
       WHERE queue_entry_id = OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.state = 'in_consultation'
     AND NEW.state IS DISTINCT FROM 'in_consultation' THEN
    DELETE FROM doctor_active_consultations
     WHERE queue_entry_id = OLD.id;
  END IF;

  IF NEW.state = 'in_consultation'
     AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state) THEN
    SELECT doctor_id
      INTO target_doctor
      FROM consultation_sessions
     WHERE id = NEW.session_id
       AND clinic_id = NEW.clinic_id;

    IF target_doctor IS NULL THEN
      RAISE EXCEPTION 'Consultation session doctor was not found'
        USING ERRCODE = '23503';
    END IF;

    BEGIN
      INSERT INTO doctor_active_consultations (doctor_id, queue_entry_id)
      VALUES (target_doctor, NEW.id);
    EXCEPTION
      WHEN unique_violation THEN
        RAISE EXCEPTION 'Doctor already has an active consultation'
          USING ERRCODE = '23514';
    END;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER queue_entries_doctor_active_guard_insert_update
AFTER INSERT OR UPDATE OF state ON queue_entries
FOR EACH ROW
EXECUTE FUNCTION sync_doctor_active_consultation_guard();

CREATE TRIGGER queue_entries_doctor_active_guard_delete
AFTER DELETE ON queue_entries
FOR EACH ROW
EXECUTE FUNCTION sync_doctor_active_consultation_guard();
