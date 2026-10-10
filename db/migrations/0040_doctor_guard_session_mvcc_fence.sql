-- WU610: a plain FOR SHARE lock does not mark the session tuple modified.
-- A REPEATABLE READ reassignment with a preexisting snapshot could later
-- UPDATE doctor_id after the queue commit while seeing no active entry.
-- Version the session tuple at the active-queue transition itself. A stale
-- snapshot doctor UPDATE must fail PostgreSQL's concurrent-update check
-- (SQLSTATE 40001), not silently bypass the doctor-active guard.
ALTER TABLE public.consultation_sessions
  ADD COLUMN doctor_guard_fence_epoch bigint NOT NULL DEFAULT 0
  CHECK (doctor_guard_fence_epoch >= 0);

CREATE OR REPLACE FUNCTION public.lock_active_queue_doctor_assignment()
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
    -- A real UPDATE takes an exclusive row lock and advances the MVCC
    -- version, fencing preexisting REPEATABLE READ doctor reassignment.
    UPDATE public.consultation_sessions
       SET doctor_guard_fence_epoch = doctor_guard_fence_epoch + 1
     WHERE id = NEW.session_id AND clinic_id = NEW.clinic_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Session missing' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;
