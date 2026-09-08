ALTER TABLE queue_entries
  ADD COLUMN in_consultation_started_at timestamptz NULL,
  ADD COLUMN completed_at timestamptz NULL;

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_consultation_timing_valid CHECK (
    completed_at IS NULL OR (
      in_consultation_started_at IS NOT NULL
      AND completed_at >= in_consultation_started_at
    )
  );

CREATE OR REPLACE FUNCTION stamp_queue_consultation_timing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state = 'in_consultation'::queue_entry_status THEN
      NEW.in_consultation_started_at := COALESCE(NEW.in_consultation_started_at, now());
      NEW.completed_at := NULL;
    ELSIF NEW.state = 'completed'::queue_entry_status THEN
      NEW.completed_at := COALESCE(NEW.completed_at, now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER queue_entries_consultation_timing_trigger
BEFORE UPDATE OF state ON queue_entries
FOR EACH ROW
EXECUTE FUNCTION stamp_queue_consultation_timing();

CREATE INDEX queue_entries_session_completed_timing_idx
  ON queue_entries (clinic_id, session_id, completed_at)
  WHERE completed_at IS NOT NULL AND in_consultation_started_at IS NOT NULL;
