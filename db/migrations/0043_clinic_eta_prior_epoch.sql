-- TAB-P0-11 / #610 slice 2: clinic-scoped historical duration prior epoch.
-- The ETA historical prior is the most recent completed consultation durations
-- of a doctor within one clinic, drawn from other sessions. A completion in one
-- session therefore changes the estimate of a different session without moving
-- that session's eta_source_epoch. This table carries one monotonic epoch per
-- (clinic, doctor) that advances at most once per committing transaction that
-- adds, changes or removes a duration sample, or re-attributes one to another
-- doctor. Database triggers cover every writer. A missing row means epoch 0.
CREATE TABLE clinic_doctor_eta_prior_epochs (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  doctor_id uuid NOT NULL REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
  eta_prior_epoch bigint NOT NULL CHECK (eta_prior_epoch >= 1),
  eta_prior_epoch_xact xid8 NOT NULL,
  PRIMARY KEY (clinic_id, doctor_id)
);

COMMENT ON TABLE clinic_doctor_eta_prior_epochs IS
  'Monotonic per-clinic-per-doctor ETA historical prior epoch maintained by triggers; never patient-visible.';

CREATE FUNCTION bump_clinic_doctor_eta_prior_epoch(target_clinic uuid, target_doctor uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO clinic_doctor_eta_prior_epochs
    (clinic_id, doctor_id, eta_prior_epoch, eta_prior_epoch_xact)
  VALUES (target_clinic, target_doctor, 1, pg_current_xact_id())
  ON CONFLICT (clinic_id, doctor_id) DO UPDATE
     SET eta_prior_epoch = clinic_doctor_eta_prior_epochs.eta_prior_epoch + 1,
         eta_prior_epoch_xact = pg_current_xact_id()
   WHERE clinic_doctor_eta_prior_epochs.eta_prior_epoch_xact
         IS DISTINCT FROM pg_current_xact_id();
END;
$$;

CREATE FUNCTION guard_clinic_doctor_eta_prior_epoch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'eta_prior_epoch is maintained by the database'
      USING ERRCODE = '23514';
  END IF;
  -- Only the bump function, called from another trigger, may write.
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'eta_prior_epoch is maintained by the database'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW.eta_prior_epoch <> OLD.eta_prior_epoch + 1
       OR NEW.clinic_id <> OLD.clinic_id
       OR NEW.doctor_id <> OLD.doctor_id) THEN
    RAISE EXCEPTION 'eta_prior_epoch is maintained by the database'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.eta_prior_epoch <> 1 THEN
    RAISE EXCEPTION 'eta_prior_epoch is maintained by the database'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clinic_doctor_eta_prior_epoch_guard
BEFORE INSERT OR UPDATE OR DELETE ON clinic_doctor_eta_prior_epochs
FOR EACH ROW
EXECUTE FUNCTION guard_clinic_doctor_eta_prior_epoch();

CREATE FUNCTION bump_queue_entry_eta_prior_epoch()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected uuid;
BEGIN
  -- A row is a duration sample only with both consultation timestamps. Lock
  -- doctors in id order so mirrored attributions cannot deadlock.
  FOR affected IN
    SELECT DISTINCT d FROM (
      SELECT (SELECT s.doctor_id FROM consultation_sessions s
               WHERE s.id = OLD.session_id AND s.clinic_id = OLD.clinic_id) AS d
       WHERE TG_OP <> 'INSERT'
         AND OLD.completed_at IS NOT NULL
         AND OLD.in_consultation_started_at IS NOT NULL
      UNION ALL
      SELECT (SELECT s.doctor_id FROM consultation_sessions s
               WHERE s.id = NEW.session_id AND s.clinic_id = NEW.clinic_id) AS d
       WHERE TG_OP <> 'DELETE'
         AND NEW.completed_at IS NOT NULL
         AND NEW.in_consultation_started_at IS NOT NULL
    ) sampled WHERE d IS NOT NULL ORDER BY d
  LOOP
    PERFORM bump_clinic_doctor_eta_prior_epoch(
      CASE WHEN TG_OP = 'DELETE' THEN OLD.clinic_id ELSE NEW.clinic_id END,
      affected);
  END LOOP;
  RETURN NULL;
END;
$$;

-- No UPDATE OF column list: the consultation timestamps are set by an earlier
-- BEFORE trigger, so they are not in the statement's SET list. The WHEN clause
-- compares the real row values instead.
-- Deferred to commit so the prior row lock is held only briefly and the bump
-- is idempotent per transaction.
CREATE CONSTRAINT TRIGGER queue_entries_eta_prior_epoch_write
AFTER INSERT OR DELETE ON queue_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION bump_queue_entry_eta_prior_epoch();

CREATE CONSTRAINT TRIGGER queue_entries_eta_prior_epoch_update
AFTER UPDATE ON queue_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  (OLD.session_id, OLD.in_consultation_started_at, OLD.completed_at)
  IS DISTINCT FROM
  (NEW.session_id, NEW.in_consultation_started_at, NEW.completed_at)
)
EXECUTE FUNCTION bump_queue_entry_eta_prior_epoch();

-- Re-attributing a session to another doctor moves every duration sample it
-- holds from one doctor's prior to the other's.
CREATE FUNCTION bump_session_doctor_eta_prior_epoch()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM queue_entries e
     WHERE e.session_id = NEW.id
       AND e.completed_at IS NOT NULL
       AND e.in_consultation_started_at IS NOT NULL
  ) THEN
    FOR affected IN
      SELECT d FROM unnest(ARRAY[OLD.doctor_id, NEW.doctor_id]) AS d ORDER BY d
    LOOP
      PERFORM bump_clinic_doctor_eta_prior_epoch(NEW.clinic_id, affected);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER consultation_sessions_eta_prior_epoch
AFTER UPDATE OF doctor_id ON consultation_sessions
FOR EACH ROW
WHEN (OLD.doctor_id IS DISTINCT FROM NEW.doctor_id)
EXECUTE FUNCTION bump_session_doctor_eta_prior_epoch();
