-- WU610: a runtime writer must not directly remove the doctor-global
-- active consultation row. Existing WU192 trigger logic is kept intact;
-- only its privilege boundary changes, in a NEW forward-only migration.
-- The migration account that created/owns the guard function must also own
-- doctor_active_consultations, consultation_sessions and queue_entries.
DO $do$
BEGIN
  IF (
    SELECT p.proowner = c.relowner
      FROM pg_proc p
      JOIN pg_namespace pn ON pn.oid=p.pronamespace
      JOIN pg_class c ON c.relname='doctor_active_consultations'
      JOIN pg_namespace cn ON cn.oid=c.relnamespace
     WHERE pn.nspname='public' AND cn.nspname='public'
       AND p.proname='sync_doctor_active_consultation_guard'
       AND p.pronargs=0
  ) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Doctor guard function/table ownership mismatch'
      USING ERRCODE='42501';
  END IF;
END
$do$;

-- Trigger-only SECURITY DEFINER: the trusted owner performs INSERT/DELETE
-- as a consequence of a queue_entries transition. The runtime login may
-- SELECT guard rows, but cannot modify the guard table directly.
ALTER FUNCTION public.sync_doctor_active_consultation_guard()
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp;

-- A runtime login never needs EXECUTE on a trigger function directly.
REVOKE ALL ON FUNCTION public.sync_doctor_active_consultation_guard()
  FROM PUBLIC;
