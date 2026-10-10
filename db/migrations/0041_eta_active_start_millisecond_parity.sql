-- WU610: versioned SQL/TypeScript ETA v1 precision compatibility.
-- PostgreSQL timestamp storage is microsecond-precision, while pg's JS Date
-- is millisecond-precision. Only canonical verifier projection changes.
-- Forward-only migration: do not rewrite already applied 0035.
CREATE OR REPLACE FUNCTION eta_expected_claim_snapshot(
  p_clinic uuid, p_session uuid, p_entry uuid,
  p_revision bigint, p_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $eta_claim$
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
      -- PostgreSQL stores microseconds but the TypeScript/pg Date model
      -- stores milliseconds. Normalize before elapsed-time ceiling and
      -- explanation-code branching to make the SQL claim verifier match.
      active_started := date_trunc('milliseconds', item.in_consultation_started_at);
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
