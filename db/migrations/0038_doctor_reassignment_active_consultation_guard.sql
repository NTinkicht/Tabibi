-- WU610: a session's doctor_id UPDATE does not fire the existing
-- status-only BEFORE UPDATE trigger. A runtime writer must not change the
-- attribution of an already active consultation behind the unique guard row.
CREATE FUNCTION enforce_doctor_reassignment_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp
AS $guard$
BEGIN
  IF OLD.doctor_id IS NOT DISTINCT FROM NEW.doctor_id THEN
    RETURN NEW;
  END IF;
  -- The existing doctor_active_consultations row is keyed to OLD.doctor_id.
  -- Reassignment would strand that guard while the queue entry stays active.
  IF EXISTS (
    SELECT 1
      FROM public.queue_entries entry
     WHERE entry.session_id = OLD.id
       AND entry.clinic_id = OLD.clinic_id
       AND entry.state = 'in_consultation'
  ) THEN
    RAISE EXCEPTION 'Cannot reassign a doctor with an active consultation'
      USING ERRCODE = '23514';
  END IF;
  -- A direct reassignment into another doctor's active session can also
  -- evade the earlier BEFORE UPDATE OF status / BEFORE INSERT checks.
  IF NEW.status = 'open' AND EXISTS (
    SELECT 1
      FROM public.consultation_sessions other
      JOIN public.queue_entries entry
        ON entry.session_id = other.id
       AND entry.clinic_id = other.clinic_id
     WHERE other.doctor_id = NEW.doctor_id
       AND other.id <> NEW.id
       AND entry.state = 'in_consultation'
  ) THEN
    RAISE EXCEPTION 'Doctor has a consultation in another session'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER consultation_sessions_doctor_reassignment_guard
BEFORE UPDATE OF doctor_id ON public.consultation_sessions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_doctor_reassignment_guard();

REVOKE ALL ON FUNCTION public.enforce_doctor_reassignment_guard() FROM PUBLIC;
