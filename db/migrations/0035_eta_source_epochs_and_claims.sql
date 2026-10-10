-- Owner-approved WU #610. Additive, transactional, clinic-scoped ETA fencing.
-- Source epochs are deliberately separate from queue_order_version, which
-- remains the historical queue-ordering/v1 concurrency authority.
CREATE TABLE eta_clinic_prior_epochs (
  clinic_id uuid PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
  prior_epoch bigint NOT NULL DEFAULT 0 CHECK (prior_epoch >= 0)
);

CREATE TABLE eta_session_source_epochs (
  clinic_id uuid NOT NULL,
  session_id uuid NOT NULL,
  source_epoch bigint NOT NULL DEFAULT 0 CHECK (source_epoch >= 0),
  PRIMARY KEY (clinic_id, session_id),
  FOREIGN KEY (session_id, clinic_id)
    REFERENCES consultation_sessions(id, clinic_id) ON DELETE CASCADE
);

-- Backfill BEFORE installing triggers. Existing sessions begin at epoch zero;
-- every subsequent relevant write is fenced by the same DB transaction.
INSERT INTO eta_clinic_prior_epochs (clinic_id)
SELECT id FROM clinics;

INSERT INTO eta_session_source_epochs (clinic_id, session_id)
SELECT clinic_id, id FROM consultation_sessions;

CREATE FUNCTION eta_create_clinic_prior_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO eta_clinic_prior_epochs (clinic_id) VALUES (NEW.id);
  RETURN NEW;
END
$$;

CREATE TRIGGER eta_create_clinic_prior_epoch_trigger
AFTER INSERT ON clinics
FOR EACH ROW EXECUTE FUNCTION eta_create_clinic_prior_epoch();

CREATE FUNCTION eta_create_session_source_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO eta_session_source_epochs (clinic_id, session_id)
  VALUES (NEW.clinic_id, NEW.id);
  RETURN NEW;
END
$$;

CREATE TRIGGER eta_create_session_source_epoch_trigger
AFTER INSERT ON consultation_sessions
FOR EACH ROW EXECUTE FUNCTION eta_create_session_source_epoch();

CREATE FUNCTION eta_increment_session_epoch(p_clinic uuid, p_session uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE eta_session_source_epochs
     SET source_epoch = source_epoch + 1
   WHERE clinic_id = p_clinic AND session_id = p_session;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Missing canonical ETA session source epoch'
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE FUNCTION eta_increment_clinic_prior_epoch(p_clinic uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE eta_clinic_prior_epochs
     SET prior_epoch = prior_epoch + 1
   WHERE clinic_id = p_clinic;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Missing canonical ETA clinic prior epoch'
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE FUNCTION eta_session_source_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.status, NEW.starts_at, NEW.ends_at, NEW.doctor_id,
    NEW.declared_delay_minutes, NEW.delay_version, NEW.delay_updated_at,
    NEW.queue_order_version, NEW.opened_at, NEW.closed_at
  ) IS NOT DISTINCT FROM ROW(
    OLD.status, OLD.starts_at, OLD.ends_at, OLD.doctor_id,
    OLD.declared_delay_minutes, OLD.delay_version, OLD.delay_updated_at,
    OLD.queue_order_version, OLD.opened_at, OLD.closed_at
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM eta_increment_session_epoch(NEW.clinic_id, NEW.id);
  -- A doctor's reassignment changes which historical samples may be used
  -- by other sessions in this clinic, even if their queues do not change.
  IF NEW.doctor_id IS DISTINCT FROM OLD.doctor_id THEN
    PERFORM eta_increment_clinic_prior_epoch(NEW.clinic_id);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER eta_session_source_changed_trigger
AFTER UPDATE OF status, starts_at, ends_at, doctor_id,
  declared_delay_minutes, delay_version, delay_updated_at,
  queue_order_version, opened_at, closed_at
ON consultation_sessions
FOR EACH ROW EXECUTE FUNCTION eta_session_source_changed();

CREATE FUNCTION eta_queue_source_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_had_prior boolean := false;
  new_has_prior boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM eta_increment_session_epoch(NEW.clinic_id, NEW.session_id);
    IF NEW.completed_at IS NOT NULL
       AND NEW.in_consultation_started_at IS NOT NULL THEN
      PERFORM eta_increment_clinic_prior_epoch(NEW.clinic_id);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM eta_increment_session_epoch(OLD.clinic_id, OLD.session_id);
    IF OLD.completed_at IS NOT NULL
       AND OLD.in_consultation_started_at IS NOT NULL THEN
      PERFORM eta_increment_clinic_prior_epoch(OLD.clinic_id);
    END IF;
    RETURN OLD;
  END IF;

  -- Do not churn epochs for unrelated changes to identity/contact labels.
  IF ROW(
    OLD.clinic_id, OLD.session_id, OLD.state,
    OLD.registration_order, OLD.eligibility_order, OLD.priority_order,
    OLD.in_consultation_started_at, OLD.completed_at
  ) IS NOT DISTINCT FROM ROW(
    NEW.clinic_id, NEW.session_id, NEW.state,
    NEW.registration_order, NEW.eligibility_order, NEW.priority_order,
    NEW.in_consultation_started_at, NEW.completed_at
  ) THEN
    RETURN NEW;
  END IF;

  -- Transfers invalidate BOTH session sources in canonical key order.
  -- This matters for direct SQL mutations as well as service commands.
  IF OLD.session_id = NEW.session_id AND OLD.clinic_id = NEW.clinic_id THEN
    PERFORM eta_increment_session_epoch(NEW.clinic_id, NEW.session_id);
  ELSIF ROW(OLD.clinic_id, OLD.session_id) <
        ROW(NEW.clinic_id, NEW.session_id) THEN
    PERFORM eta_increment_session_epoch(OLD.clinic_id, OLD.session_id);
    PERFORM eta_increment_session_epoch(NEW.clinic_id, NEW.session_id);
  ELSE
    PERFORM eta_increment_session_epoch(NEW.clinic_id, NEW.session_id);
    PERFORM eta_increment_session_epoch(OLD.clinic_id, OLD.session_id);
  END IF;

  old_had_prior := OLD.completed_at IS NOT NULL
    AND OLD.in_consultation_started_at IS NOT NULL;
  new_has_prior := NEW.completed_at IS NOT NULL
    AND NEW.in_consultation_started_at IS NOT NULL;
  IF old_had_prior OR new_has_prior THEN
    IF OLD.clinic_id IS DISTINCT FROM NEW.clinic_id THEN
      IF old_had_prior THEN
        PERFORM eta_increment_clinic_prior_epoch(OLD.clinic_id);
      END IF;
      IF new_has_prior THEN
        PERFORM eta_increment_clinic_prior_epoch(NEW.clinic_id);
      END IF;
    ELSIF ROW(OLD.session_id, OLD.state,
              OLD.in_consultation_started_at, OLD.completed_at)
          IS DISTINCT FROM
          ROW(NEW.session_id, NEW.state,
              NEW.in_consultation_started_at, NEW.completed_at) THEN
      PERFORM eta_increment_clinic_prior_epoch(NEW.clinic_id);
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER eta_queue_source_changed_insert
AFTER INSERT ON queue_entries
FOR EACH ROW EXECUTE FUNCTION eta_queue_source_changed();
CREATE TRIGGER eta_queue_source_changed_update
AFTER UPDATE ON queue_entries
FOR EACH ROW EXECUTE FUNCTION eta_queue_source_changed();
CREATE TRIGGER eta_queue_source_changed_delete
AFTER DELETE ON queue_entries
FOR EACH ROW EXECUTE FUNCTION eta_queue_source_changed();

-- The session-scoped reorder-audit index is installed online by the
-- separate non-transactional migration 0036, after this schema transaction.
CREATE FUNCTION eta_audit_source_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_session uuid;
  new_session uuid;
  old_clinic uuid;
  new_clinic uuid;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE')
     AND OLD.action = 'queue_entry.reordered' THEN
    SELECT session_id, clinic_id INTO old_session, old_clinic
      FROM eta_session_source_epochs
     WHERE clinic_id = OLD.clinic_id
       AND session_id::text = OLD.metadata->>'sessionId';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW.action = 'queue_entry.reordered' THEN
    SELECT session_id, clinic_id INTO new_session, new_clinic
      FROM eta_session_source_epochs
     WHERE clinic_id = NEW.clinic_id
       AND session_id::text = NEW.metadata->>'sessionId';
  END IF;
  -- Existing service-authored reorder audits occur in the same transaction
  -- as queue updates. Corrected evidence that moves between two sessions
  -- must lock their epoch rows in canonical (clinic_id, session_id) order.
  -- Opposing corrections A->B and B->A cannot then form a lock cycle.
  IF old_session IS NOT NULL AND new_session IS NOT NULL AND
     ROW(old_clinic, old_session) IS DISTINCT FROM
     ROW(new_clinic, new_session) THEN
    IF ROW(old_clinic, old_session) <
       ROW(new_clinic, new_session) THEN
      PERFORM eta_increment_session_epoch(old_clinic, old_session);
      PERFORM eta_increment_session_epoch(new_clinic, new_session);
    ELSE
      PERFORM eta_increment_session_epoch(new_clinic, new_session);
      PERFORM eta_increment_session_epoch(old_clinic, old_session);
    END IF;
  ELSE
    IF old_session IS NOT NULL THEN
      PERFORM eta_increment_session_epoch(old_clinic, old_session);
    END IF;
    IF new_session IS NOT NULL AND (
      old_session IS DISTINCT FROM new_session
      OR old_clinic IS DISTINCT FROM new_clinic
      OR TG_OP <> 'UPDATE'
      OR OLD.metadata IS DISTINCT FROM NEW.metadata
    ) THEN
      PERFORM eta_increment_session_epoch(new_clinic, new_session);
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER eta_audit_source_changed_trigger
AFTER INSERT OR UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION eta_audit_source_changed();

-- Claims preserve historical evidence; an epoch change creates a new tuple.
-- No public endpoint returns the per-clinic prior epoch or claim identifiers.
CREATE TABLE eta_uncertainty_claims (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL,
  queue_entry_id uuid NOT NULL,
  source_epoch bigint NOT NULL CHECK (source_epoch >= 0),
  clinic_prior_epoch bigint NOT NULL CHECK (clinic_prior_epoch >= 0),
  queue_revision bigint NOT NULL CHECK (queue_revision >= 0),
  estimate_version text NOT NULL CHECK (estimate_version = 'eta-uncertainty/v1'),
  evaluated_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, clinic_id)
    REFERENCES consultation_sessions(id, clinic_id) ON DELETE RESTRICT,
  UNIQUE (
    clinic_id, session_id, queue_entry_id, source_epoch, clinic_prior_epoch,
    estimate_version, evaluated_at
  )
);

CREATE INDEX eta_uncertainty_claims_session_idx
  ON eta_uncertainty_claims (clinic_id, session_id, claimed_at DESC);

-- Even direct INSERTs must supply a fresh exact source tuple. Lock epoch rows
-- in canonical order (session source THEN clinic prior) for the duration of
-- the surrounding INSERT transaction; writers update these same rows.
CREATE FUNCTION eta_guard_claim_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actual_source bigint;
  actual_prior bigint;
  actual_queue_revision bigint;
  actual_status session_status;
BEGIN
  SELECT source_epoch INTO actual_source
    FROM eta_session_source_epochs
   WHERE clinic_id = NEW.clinic_id AND session_id = NEW.session_id
   FOR SHARE;
  SELECT prior_epoch INTO actual_prior
    FROM eta_clinic_prior_epochs
   WHERE clinic_id = NEW.clinic_id
   FOR SHARE;

  IF actual_source IS DISTINCT FROM NEW.source_epoch
     OR actual_prior IS DISTINCT FROM NEW.clinic_prior_epoch THEN
    RAISE EXCEPTION 'ETA publication source epochs changed'
      USING ERRCODE = '40001';
  END IF;

  SELECT queue_order_version, status INTO actual_queue_revision, actual_status
    FROM consultation_sessions
   WHERE id = NEW.session_id AND clinic_id = NEW.clinic_id;

  IF actual_status IS DISTINCT FROM 'open'
     OR actual_queue_revision IS DISTINCT FROM NEW.queue_revision
     OR NOT EXISTS (
       SELECT 1 FROM queue_entries entry
        WHERE entry.id = NEW.queue_entry_id
          AND entry.clinic_id = NEW.clinic_id
          AND entry.session_id = NEW.session_id
          AND entry.state IN ('checked_in', 'called', 'in_consultation')
     ) THEN
    RAISE EXCEPTION 'ETA publication scope or queue state is not current'
      USING ERRCODE = '40001';
  END IF;

  IF NEW.snapshot->>'estimateVersion' IS DISTINCT FROM NEW.estimate_version
     OR NEW.snapshot->>'queueRevision' IS DISTINCT FROM NEW.queue_revision::text
     OR jsonb_typeof(NEW.snapshot->'explanationCodes') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.snapshot->'earliestMinutes') IS DISTINCT FROM 'number'
     OR jsonb_typeof(NEW.snapshot->'expectedMinutes') IS DISTINCT FROM 'number'
     OR jsonb_typeof(NEW.snapshot->'latestMinutes') IS DISTINCT FROM 'number'
     OR NEW.snapshot->>'evaluatedAt' IS DISTINCT FROM
       to_char(NEW.evaluated_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     OR (SELECT count(*) FROM jsonb_object_keys(NEW.snapshot)) <> 7
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(NEW.snapshot) AS field(key)
        WHERE key NOT IN (
          'earliestMinutes','expectedMinutes','latestMinutes',
          'estimateVersion','queueRevision','evaluatedAt','explanationCodes'
        )
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'explanationCodes') AS code(value)
        WHERE jsonb_typeof(value) <> 'string'
     ) THEN
    RAISE EXCEPTION 'ETA publication payload is not the versioned public-safe tuple'
      USING ERRCODE = '22023';
  END IF;

  -- The database is the last line of defense even for direct SQL writers.
  -- Accept only bounded normalized whole-minute values and public-safe codes.
  IF (NEW.snapshot->>'earliestMinutes')::numeric < 0
     OR (NEW.snapshot->>'latestMinutes')::numeric > 9007199254740991
     OR (NEW.snapshot->>'earliestMinutes')::numeric >
        (NEW.snapshot->>'expectedMinutes')::numeric
     OR (NEW.snapshot->>'expectedMinutes')::numeric >
        (NEW.snapshot->>'latestMinutes')::numeric
     OR (NEW.snapshot->>'earliestMinutes')::numeric <> trunc(
        (NEW.snapshot->>'earliestMinutes')::numeric)
     OR (NEW.snapshot->>'expectedMinutes')::numeric <> trunc(
        (NEW.snapshot->>'expectedMinutes')::numeric)
     OR (NEW.snapshot->>'latestMinutes')::numeric <> trunc(
        (NEW.snapshot->>'latestMinutes')::numeric)
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(NEW.snapshot->'explanationCodes')
              AS reason(code)
        WHERE code NOT IN (
          'queue-depth','called-not-started',
          'active-consultation-remaining','active-consultation-overrun',
          'declared-delay','priority-change','fallback',
          'observed-median','historical-median','paused-state'
        )
     ) THEN
    RAISE EXCEPTION 'ETA publication evidence is not normalized or public-safe'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER eta_guard_claim_publication_insert
BEFORE INSERT ON eta_uncertainty_claims
FOR EACH ROW EXECUTE FUNCTION eta_guard_claim_publication();

CREATE FUNCTION eta_claim_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published ETA evidence is immutable'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER eta_claim_immutable_update_delete
BEFORE UPDATE OR DELETE ON eta_uncertainty_claims
FOR EACH ROW EXECUTE FUNCTION eta_claim_immutable();
