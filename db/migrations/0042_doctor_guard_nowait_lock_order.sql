-- WU610: prevent queue -> session blocking deadlocks against legitimate
-- session -> queue cancellation, while retaining the MVCC stale-reader fence.
-- A contended queue transition fails immediately with 55P03, never waits on
-- the session row while holding its own queue row lock.
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
    -- Never wait on a session lock while the queue UPDATE holds a queue
    -- row lock: session cancellation uses session -> queue ordering.
    -- NOWAIT aborts this queue transition with 55P03 before a cycle forms.
    -- A successful lock is then followed by a REAL row version UPDATE,
    -- retaining stale REPEATABLE READ protection established in 0040.
    PERFORM 1 FROM public.consultation_sessions
     WHERE id = NEW.session_id AND clinic_id = NEW.clinic_id
     FOR UPDATE NOWAIT;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Session missing' USING ERRCODE = '23503';
    END IF;
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
