-- WU192: enforce the doctor-global active-consultation invariant at the
-- database boundary. Application start_consultation takes this same advisory
-- lock before its local session row lock; this trigger protects direct/future
-- writers and serializes concurrent cross-clinic consultation starts.
CREATE FUNCTION enforce_doctor_global_active_consultation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_doctor uuid;
BEGIN
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

    PERFORM pg_advisory_xact_lock(hashtext(target_doctor::text));

    IF EXISTS (
      SELECT 1
        FROM queue_entries entry
        JOIN consultation_sessions session
          ON session.id = entry.session_id
         AND session.clinic_id = entry.clinic_id
       WHERE session.doctor_id = target_doctor
         AND entry.id <> NEW.id
         AND entry.state = 'in_consultation'
    ) THEN
      RAISE EXCEPTION 'Doctor already has an active consultation'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER queue_entries_doctor_global_consultation_guard
BEFORE INSERT OR UPDATE OF state ON queue_entries
FOR EACH ROW
EXECUTE FUNCTION enforce_doctor_global_active_consultation();
