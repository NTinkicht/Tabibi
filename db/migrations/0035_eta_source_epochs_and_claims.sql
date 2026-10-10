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

-- A stable caller-created request key survives lost acknowledgements and
-- makes concurrent exact retries converge even after the source epoch moves.
-- Each receipt is committed atomically with its immutable claim.
ALTER TABLE eta_uncertainty_claims
  ADD CONSTRAINT eta_claim_id_scope_uq
  UNIQUE (id, clinic_id, session_id, queue_entry_id);

CREATE TABLE eta_claim_idempotency_receipts (
  clinic_id uuid NOT NULL,
  request_key text NOT NULL
    CHECK (char_length(request_key) BETWEEN 1 AND 128),
  session_id uuid NOT NULL,
  queue_entry_id uuid NOT NULL,
  claim_id bigint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, request_key),
  FOREIGN KEY (claim_id, clinic_id, session_id, queue_entry_id)
    REFERENCES eta_uncertainty_claims (id, clinic_id, session_id, queue_entry_id)
    ON DELETE RESTRICT
);

-- Even direct INSERTs must supply a fresh exact source tuple. Lock epoch rows
-- in canonical order (session source THEN clinic prior) for the duration of
-- the surrounding INSERT transaction; writers update these same rows.
-- Canonical database-side verification for persisted ETA claims. This is a
-- second, independent implementation of the versioned v1 contract, NOT an
-- application-controlled attestable flag. Its parity with the TypeScript
-- estimator is tested by integration tests against identical committed state.
-- Reads the same fenced REPEATABLE READ source snapshot as the claim trigger.
CREATE FUNCTION eta_expected_claim_snapshot(
  p_clinic uuid, p_session uuid, p_entry uuid,
  p_revision bigint, p_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $eta_claim$
DECLARE
  ses consultation_sessions%ROWTYPE;
  item record;
  target_seen boolean := false;
  ahead_count integer := 0;
  active_count integer := 0;
  called_count integer := 0;
  active_started timestamptz;
  influence_ids text[] := ARRAY[p_entry::text];
  sample_count integer;
  sampled_duration double precision;
  duration double precision := 15;
  duration_source text := 'fallback';
  delay_minutes double precision;
  active_minutes double precision := 0;
  queued_slots integer;
  base_minutes double precision;
  raw_earliest double precision;
  raw_expected double precision;
  raw_latest double precision;
  earliest bigint;
  expected bigint;
  latest bigint;
  priority_changed boolean := false;
  codes jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO ses FROM consultation_sessions
   WHERE id=p_session AND clinic_id=p_clinic AND status='open';
  IF NOT FOUND OR p_revision < 0 OR p_revision > 9007199254740991
     OR p_at IS NULL THEN
    RETURN NULL;
  END IF;

  -- Exactly the v1 service-order projection: active, called, checked-in;
  -- preserve the original within-state priority/eligibility/registration order.
  FOR item IN
    SELECT q.id, q.state, q.in_consultation_started_at
      FROM queue_entries q
     WHERE q.clinic_id=p_clinic AND q.session_id=p_session
       AND q.state IN ('in_consultation','called','checked_in')
     ORDER BY CASE q.state
         WHEN 'in_consultation' THEN 0 WHEN 'called' THEN 1 ELSE 2 END,
       CASE WHEN q.priority_order IS NULL THEN 1 ELSE 0 END,
       q.priority_order NULLS LAST, q.eligibility_order NULLS LAST,
       q.registration_order NULLS LAST, q.id NULLS LAST
  LOOP
    IF item.id=p_entry THEN
      target_seen := true;
      EXIT;
    END IF;
    ahead_count := ahead_count+1;
    influence_ids := array_append(influence_ids, item.id::text);
    IF item.state='in_consultation' THEN
      active_count := active_count+1;
      active_started := item.in_consultation_started_at;
    ELSIF item.state='called' THEN
      called_count := called_count+1;
    END IF;
  END LOOP;

  IF NOT target_seen OR active_count > 1
     OR (active_count=1 AND
       (active_started IS NULL OR active_started > p_at)) THEN
    RETURN NULL;
  END IF;

  -- Exact TypeScript sample policy: all current-session completed durations,
  -- otherwise up to 20 completed sessions from the same doctor strictly
  -- before this session's start, clamped to [2,120], median with >=3 samples.
  SELECT count(*)::integer,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY samples.minutes)
    INTO sample_count, sampled_duration
    FROM (
      SELECT LEAST(120.0, GREATEST(2.0,
        EXTRACT(EPOCH FROM (q.completed_at-q.in_consultation_started_at))
          ::double precision / 60.0)) AS minutes
        FROM queue_entries q
       WHERE q.clinic_id=p_clinic AND q.session_id=p_session
         AND q.completed_at IS NOT NULL
         AND q.in_consultation_started_at IS NOT NULL
    ) samples;

  IF sample_count >= 3 THEN
    duration := sampled_duration;
    duration_source := 'observed_median';
  ELSE
    SELECT count(*)::integer,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY samples.minutes)
      INTO sample_count, sampled_duration
      FROM (
        SELECT LEAST(120.0, GREATEST(2.0,
          EXTRACT(EPOCH FROM (q.completed_at-q.in_consultation_started_at))
            ::double precision / 60.0)) AS minutes
          FROM queue_entries q
          JOIN consultation_sessions historic
            ON historic.id=q.session_id AND historic.clinic_id=q.clinic_id
         WHERE q.clinic_id=p_clinic AND historic.doctor_id=ses.doctor_id
           AND historic.id<>p_session
           AND q.completed_at IS NOT NULL
           AND q.in_consultation_started_at IS NOT NULL
           AND q.completed_at<ses.starts_at
         ORDER BY q.completed_at DESC, q.id DESC
         LIMIT 20
      ) samples;
    IF sample_count >= 3 THEN
      duration := sampled_duration;
      duration_source := 'historical_median';
    END IF;
  END IF;

  delay_minutes := coalesce(ses.declared_delay_minutes,0)::double precision;
  IF active_count=1 THEN
    active_minutes := GREATEST(0.0, CEIL(
      LEAST(120.0,GREATEST(2.0,duration))
      - EXTRACT(EPOCH FROM (p_at-active_started))::double precision / 60.0
    ));
  END IF;
  queued_slots := ahead_count - active_count;
  base_minutes := delay_minutes + active_minutes;
  raw_earliest := base_minutes + queued_slots*duration*0.75;
  raw_expected := base_minutes + queued_slots*duration;
  raw_latest := base_minutes + queued_slots*duration*1.5;
  IF raw_earliest=raw_expected AND raw_expected=raw_latest THEN
    earliest := ROUND(raw_expected::numeric)::bigint;
    expected := earliest;
    latest := earliest;
  ELSE
    earliest := FLOOR(raw_earliest::numeric)::bigint;
    expected := ROUND(raw_expected::numeric)::bigint;
    latest := CEIL(raw_latest::numeric)::bigint;
  END IF;
  IF earliest < 0 OR earliest > expected OR expected > latest
     OR latest > 9007199254740991 THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM audit_events a
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(a.metadata->'resultingOrder')='array'
             THEN a.metadata->'resultingOrder' ELSE '[]'::jsonb END
      ) affected
     WHERE a.clinic_id=p_clinic AND a.action='queue_entry.reordered'
       AND a.metadata->>'sessionId'=p_session::text
       AND affected->>'entryId'=ANY(influence_ids)
  ) INTO priority_changed;
  IF queued_slots>0 THEN codes:=codes||jsonb_build_array('queue-depth'); END IF;
  IF called_count>0 THEN codes:=codes||jsonb_build_array('called-not-started'); END IF;
  IF active_minutes>0 THEN
    codes:=codes||jsonb_build_array('active-consultation-remaining');
  ELSIF active_count=1 THEN
    codes:=codes||jsonb_build_array('active-consultation-overrun');
  END IF;
  IF delay_minutes>0 THEN codes:=codes||jsonb_build_array('declared-delay'); END IF;
  IF priority_changed THEN codes:=codes||jsonb_build_array('priority-change'); END IF;
  codes:=codes||jsonb_build_array(replace(duration_source,'_','-'));

  RETURN jsonb_build_object(
    'earliestMinutes',earliest, 'expectedMinutes',expected,
    'latestMinutes',latest, 'estimateVersion','eta-uncertainty/v1',
    'queueRevision',p_revision,
    'evaluatedAt',to_char(p_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'explanationCodes',codes);
END
$eta_claim$;

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

  -- New claims MUST bind to a database-owned evaluation instant:
  -- the millisecond-normalized transaction timestamp. A tolerated window
  -- would let direct SQL persist stale estimates with perfectly current
  -- epochs. The application reads this SAME value inside claimCurrent's
  -- publishing transaction; historical replay uses SELECT, not INSERT.
  -- transaction_timestamp() remains fixed at BEGIN. An arbitrarily old
  -- snapshot may not be published even if its source epochs are unchanged.
  -- Discard a transaction older than the bounded five-second claim budget.
  IF NEW.evaluated_at IS DISTINCT FROM
       date_trunc('milliseconds', transaction_timestamp())
     OR clock_timestamp() - transaction_timestamp() > interval '5 seconds'
     OR transaction_timestamp() - clock_timestamp() > interval '5 seconds' THEN
    RAISE EXCEPTION 'ETA evaluation instant is not a fresh database transaction timestamp'
      USING ERRCODE = '22023';
  END IF;

  -- A direct SQL writer cannot attest arbitrary well-formed ETA numbers.
  -- Independently recompute the v1 payload from the same committed, epoch-
  -- fenced queue snapshot and reject every semantically forged value.
  IF NEW.snapshot IS DISTINCT FROM eta_expected_claim_snapshot(
       NEW.clinic_id, NEW.session_id, NEW.queue_entry_id,
       NEW.queue_revision, NEW.evaluated_at) THEN
    RAISE EXCEPTION 'ETA evidence differs from canonical committed source'
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

CREATE TRIGGER eta_claim_receipt_immutable_update_delete
BEFORE UPDATE OR DELETE ON eta_claim_idempotency_receipts
FOR EACH ROW EXECUTE FUNCTION eta_claim_immutable();
