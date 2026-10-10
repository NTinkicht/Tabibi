-- Serialize queue activation with session doctor reassignment.
-- Acquire the session row lock BEFORE the existing queue AFTER triggers,
-- which advance ETA source epochs and maintain the doctor-global guard.
CREATE FUNCTION lock_active_queue_doctor_assignment()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp
AS $guard$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.state = 'in_consultation'
     AND (OLD.session_id IS DISTINCT FROM NEW.session_id
          OR OLD.clinic_id IS DISTINCT FROM NEW.clinic_id) THEN
    RAISE EXCEPTION 'Active consultation cannot change session'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'in_consultation'
     AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state) THEN
    -- FOR SHARE conflicts with the non-key UPDATE of doctor_id and is held
    -- until commit. The existing AFTER trigger then reads a stable doctor.
    PERFORM 1 FROM public.consultation_sessions
      WHERE id = NEW.session_id AND clinic_id = NEW.clinic_id
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Session missing' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER queue_entries_lock_doctor_assignment
BEFORE INSERT OR UPDATE OF state, session_id, clinic_id
ON public.queue_entries
FOR EACH ROW EXECUTE FUNCTION public.lock_active_queue_doctor_assignment();

REVOKE ALL ON FUNCTION public.lock_active_queue_doctor_assignment()
  FROM PUBLIC;
