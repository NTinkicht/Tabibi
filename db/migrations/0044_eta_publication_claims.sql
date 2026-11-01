-- TAB-P0-11 / #610 slice 3: claim-only ETA publication evidence with an atomic
-- epoch compare-and-set. A claim binds one ETA evaluation to the full source
-- tuple (clinic, session, entry, session epoch, clinic/doctor prior epoch,
-- contract version, evaluation instant) plus a digest of the evidence. A claim
-- is only inserted when both expected epochs are still current, so zero rows
-- means stale: the caller discards and recomputes from a fresh snapshot.
-- Rows are immutable. Identical retries converge on the existing row; a retry
-- with a different digest for the same tuple is refused.
CREATE TABLE eta_publication_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL,
  session_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  session_epoch bigint NOT NULL CHECK (session_epoch >= 0),
  prior_epoch bigint NOT NULL CHECK (prior_epoch >= 0),
  contract_version text NOT NULL CHECK (contract_version ~ '^[a-z][a-z0-9-]*/v[0-9]+$'),
  evaluated_at timestamptz NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, clinic_id)
    REFERENCES consultation_sessions(id, clinic_id) ON DELETE RESTRICT,
  FOREIGN KEY (entry_id, clinic_id)
    REFERENCES queue_entries(id, clinic_id) ON DELETE RESTRICT,
  CONSTRAINT eta_publication_claims_tuple_uq UNIQUE
    (clinic_id, session_id, entry_id, session_epoch, prior_epoch, contract_version, evaluated_at)
);

COMMENT ON TABLE eta_publication_claims IS
  'Immutable claim-only ETA publication evidence; epochs and keys are never patient-visible.';

CREATE FUNCTION guard_eta_publication_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_session_epoch bigint;
  current_prior_epoch bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'eta_publication_claims rows are immutable'
      USING ERRCODE = '23514';
  END IF;
  -- Table-level CAS so no writer can record a claim for an outdated tuple.
  SELECT s.eta_source_epoch,
         COALESCE((SELECT p.eta_prior_epoch FROM clinic_doctor_eta_prior_epochs p
                    WHERE p.clinic_id = s.clinic_id AND p.doctor_id = s.doctor_id), 0)
    INTO current_session_epoch, current_prior_epoch
    FROM consultation_sessions s
   WHERE s.id = NEW.session_id AND s.clinic_id = NEW.clinic_id;
  IF current_session_epoch IS DISTINCT FROM NEW.session_epoch
     OR current_prior_epoch IS DISTINCT FROM NEW.prior_epoch THEN
    RAISE EXCEPTION 'eta publication claim is stale'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER eta_publication_claims_guard
BEFORE INSERT OR UPDATE OR DELETE ON eta_publication_claims
FOR EACH ROW
EXECUTE FUNCTION guard_eta_publication_claim();

-- Returns outcome 'created' (new claim), 'existing' (identical retry) or
-- 'stale' (an expected epoch moved, or the entry/session/clinic tuple does not
-- match). A same-tuple retry carrying a different digest raises 23505.
CREATE FUNCTION claim_eta_publication(
  p_clinic_id uuid,
  p_session_id uuid,
  p_entry_id uuid,
  p_expected_session_epoch bigint,
  p_expected_prior_epoch bigint,
  p_contract_version text,
  p_evaluated_at timestamptz,
  p_evidence_digest text
)
RETURNS TABLE (outcome text, claim_id uuid, claimed_digest text)
LANGUAGE plpgsql AS $$
DECLARE
  new_id uuid;
  found_id uuid;
  found_digest text;
BEGIN
  -- Share-lock the epoch rows so a writer's commit-time bump orders after this
  -- claim instead of interleaving with it. A missing prior row is epoch 0.
  PERFORM 1 FROM consultation_sessions
   WHERE id = p_session_id AND clinic_id = p_clinic_id FOR SHARE;
  PERFORM 1 FROM clinic_doctor_eta_prior_epochs p
    JOIN consultation_sessions s ON s.clinic_id = p.clinic_id AND s.doctor_id = p.doctor_id
   WHERE s.id = p_session_id AND s.clinic_id = p_clinic_id FOR SHARE OF p;

  INSERT INTO eta_publication_claims
    (clinic_id, session_id, entry_id, session_epoch, prior_epoch,
     contract_version, evaluated_at, evidence_digest)
  SELECT p_clinic_id, p_session_id, p_entry_id, s.eta_source_epoch,
         COALESCE(pe.eta_prior_epoch, 0), p_contract_version, p_evaluated_at, p_evidence_digest
    FROM consultation_sessions s
    JOIN queue_entries q ON q.id = p_entry_id AND q.session_id = s.id AND q.clinic_id = s.clinic_id
    LEFT JOIN clinic_doctor_eta_prior_epochs pe
      ON pe.clinic_id = s.clinic_id AND pe.doctor_id = s.doctor_id
   WHERE s.id = p_session_id AND s.clinic_id = p_clinic_id
     AND s.eta_source_epoch = p_expected_session_epoch
     AND COALESCE(pe.eta_prior_epoch, 0) = p_expected_prior_epoch
  ON CONFLICT ON CONSTRAINT eta_publication_claims_tuple_uq DO NOTHING
  RETURNING id INTO new_id;

  IF new_id IS NOT NULL THEN
    RETURN QUERY SELECT 'created'::text, new_id, p_evidence_digest;
    RETURN;
  END IF;

  -- Conflict or stale. Only a claim whose epochs are still current may be
  -- returned as an identical retry; anything else is stale.
  SELECT c.id, c.evidence_digest INTO found_id, found_digest
    FROM eta_publication_claims c
    JOIN consultation_sessions s ON s.id = c.session_id AND s.clinic_id = c.clinic_id
   WHERE c.clinic_id = p_clinic_id AND c.session_id = p_session_id AND c.entry_id = p_entry_id
     AND c.session_epoch = p_expected_session_epoch AND c.prior_epoch = p_expected_prior_epoch
     AND c.contract_version = p_contract_version AND c.evaluated_at = p_evaluated_at
     AND s.eta_source_epoch = p_expected_session_epoch
     AND COALESCE((SELECT p.eta_prior_epoch FROM clinic_doctor_eta_prior_epochs p
                    WHERE p.clinic_id = s.clinic_id AND p.doctor_id = s.doctor_id), 0)
         = p_expected_prior_epoch;
  IF found_id IS NULL THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  IF found_digest <> p_evidence_digest THEN
    RAISE EXCEPTION 'eta publication claim digest conflict'
      USING ERRCODE = '23505';
  END IF;
  RETURN QUERY SELECT 'existing'::text, found_id, found_digest;
END;
$$;
