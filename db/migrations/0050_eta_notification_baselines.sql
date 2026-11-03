-- TAB-P0-13 (#751): per-queue-entry baseline of the last ETA snapshot that
-- produced a material-change notification intent. The ETA notification gate
-- compares each new published snapshot to this baseline. The row holds only
-- numbers and contract identifiers; no patient identity, contact or free text.
-- The revision only moves forward (enforced by the store compare-and-advance and
-- by the trigger below) so a late or replayed writer cannot regress the baseline.
CREATE TABLE eta_notification_baselines (
  queue_entry_id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  estimator_version text NOT NULL CHECK (length(btrim(estimator_version)) > 0),
  session_epoch bigint NOT NULL CHECK (session_epoch >= 0),
  prior_epoch bigint NOT NULL CHECK (prior_epoch >= 0),
  min_wait_minutes double precision NOT NULL CHECK (min_wait_minutes >= 0),
  max_wait_minutes double precision NOT NULL,
  queue_position integer NOT NULL CHECK (queue_position > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (queue_entry_id, clinic_id)
    REFERENCES queue_entries(id, clinic_id) ON DELETE CASCADE,
  CHECK (max_wait_minutes >= min_wait_minutes)
);

CREATE FUNCTION eta_notification_baseline_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision <= OLD.revision OR NEW.clinic_id <> OLD.clinic_id THEN
    RAISE EXCEPTION 'eta notification baseline must only advance'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER eta_notification_baselines_forward_only
  BEFORE UPDATE ON eta_notification_baselines
  FOR EACH ROW EXECUTE FUNCTION eta_notification_baseline_forward_only();
