-- WU173: one doctor's consultation must block opening a different clinic's
-- session even when the prior session was paused mid-consultation.
-- Open/open uniqueness alone is insufficient for this cross-clinic case.
CREATE FUNCTION enforce_doctor_consultation_open_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'open' AND OLD.status IS DISTINCT FROM 'open' AND EXISTS (
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

CREATE TRIGGER consultation_sessions_doctor_consultation_open_guard
BEFORE UPDATE OF status ON consultation_sessions
FOR EACH ROW
EXECUTE FUNCTION enforce_doctor_consultation_open_guard();
