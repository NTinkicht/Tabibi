-- WU177: WU173's BEFORE UPDATE OF status guard cannot inspect a direct
-- INSERT that already requests open. Keep this companion guard immutable and
-- leave the existing UPDATE trigger in place.
CREATE FUNCTION enforce_doctor_consultation_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'open' AND EXISTS (
    SELECT 1
      FROM consultation_sessions other
      JOIN queue_entries entry
        ON entry.session_id = other.id
       AND entry.clinic_id = other.clinic_id
     WHERE other.doctor_id = NEW.doctor_id
       AND other.id <> NEW.id
       AND entry.state = 'in_consultation'
  ) THEN
    RAISE EXCEPTION
      'Doctor has a consultation in another session'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER consultation_sessions_doctor_consultation_insert_guard
BEFORE INSERT ON consultation_sessions
FOR EACH ROW
EXECUTE FUNCTION enforce_doctor_consultation_insert_guard();
