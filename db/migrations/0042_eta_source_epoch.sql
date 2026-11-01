-- TAB-P0-11 / #610 slice 1: canonical per-session ETA source epoch.
-- queue_order_version only moves on reorder, so delay, pause/resume, check-in,
-- consultation start/complete, cancellation and transfer could change an ETA
-- without any persisted revision moving. eta_source_epoch advances at most
-- once per committing transaction that changes any ETA source, maintained by
-- database triggers so that every writer and recovery path is covered.
ALTER TABLE consultation_sessions
  ADD COLUMN eta_source_epoch bigint NOT NULL DEFAULT 0
    CHECK (eta_source_epoch >= 0),
  ADD COLUMN eta_source_epoch_xact xid8;

COMMENT ON COLUMN consultation_sessions.eta_source_epoch IS
  'Monotonic ETA source epoch maintained by triggers; not queue_order_version and never patient-visible.';

CREATE FUNCTION bump_session_eta_source_epoch(target_session uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE consultation_sessions
     SET eta_source_epoch = eta_source_epoch + 1,
         eta_source_epoch_xact = pg_current_xact_id()
   WHERE id = target_session
     AND eta_source_epoch_xact IS DISTINCT FROM pg_current_xact_id();
END;
$$;

CREATE FUNCTION maintain_session_eta_source_epoch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.eta_source_epoch IS DISTINCT FROM OLD.eta_source_epoch
     OR NEW.eta_source_epoch_xact IS DISTINCT FROM OLD.eta_source_epoch_xact THEN
    -- Only the bump function, called from a trigger, may move the epoch.
    IF pg_trigger_depth() < 2 OR NEW.eta_source_epoch < OLD.eta_source_epoch THEN
      RAISE EXCEPTION 'eta_source_epoch is maintained by the database'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.status, NEW.declared_delay_minutes, NEW.delay_version,
      NEW.starts_at, NEW.ends_at, NEW.doctor_id)
     IS DISTINCT FROM
     (OLD.status, OLD.declared_delay_minutes, OLD.delay_version,
      OLD.starts_at, OLD.ends_at, OLD.doctor_id)
     AND OLD.eta_source_epoch_xact IS DISTINCT FROM pg_current_xact_id() THEN
    NEW.eta_source_epoch := OLD.eta_source_epoch + 1;
    NEW.eta_source_epoch_xact := pg_current_xact_id();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER consultation_sessions_eta_source_epoch
BEFORE UPDATE ON consultation_sessions
FOR EACH ROW
EXECUTE FUNCTION maintain_session_eta_source_epoch();

CREATE FUNCTION bump_queue_entry_eta_source_epoch()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected uuid;
BEGIN
  -- Lock in id order so a transfer cannot deadlock with its mirror image.
  FOR affected IN
    SELECT DISTINCT s FROM unnest(ARRAY[
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.session_id END,
      CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.session_id END
    ]) AS s WHERE s IS NOT NULL ORDER BY s
  LOOP
    PERFORM bump_session_eta_source_epoch(affected);
  END LOOP;
  RETURN NULL;
END;
$$;

-- Deferred to commit: the session cancellation guard rewrites queue entries
-- from inside the session UPDATE, so bumping inline would touch the session
-- row twice in one command. At commit the bump is idempotent per transaction.
CREATE CONSTRAINT TRIGGER queue_entries_eta_source_epoch_write
AFTER INSERT OR DELETE ON queue_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION bump_queue_entry_eta_source_epoch();

CREATE CONSTRAINT TRIGGER queue_entries_eta_source_epoch_update
AFTER UPDATE OF state, session_id, registration_order, eligibility_order, priority_order,
  in_consultation_started_at, completed_at
ON queue_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  (OLD.state, OLD.session_id, OLD.registration_order, OLD.eligibility_order, OLD.priority_order,
   OLD.in_consultation_started_at, OLD.completed_at)
  IS DISTINCT FROM
  (NEW.state, NEW.session_id, NEW.registration_order, NEW.eligibility_order, NEW.priority_order,
   NEW.in_consultation_started_at, NEW.completed_at)
)
EXECUTE FUNCTION bump_queue_entry_eta_source_epoch();
