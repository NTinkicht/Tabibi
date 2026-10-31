-- TAB-P0-03 (#687, #669 Q2 = A): 1 to 3 controlled specialty codes per
-- clinic-doctor association, set by that clinic's clinic_admin. The specialty
-- belongs to the association, never to the shared doctor_profiles row, so the
-- same doctor can hold different specialties at two clinics. An empty array
-- means not yet set. The accepted codes are exactly the TypeScript list
-- tabibi-specialties-v1 (src/modules/clinic/specialties.ts).

CREATE FUNCTION tabibi_text_array_has_no_duplicates(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(value) = (SELECT count(DISTINCT item) FROM unnest(value) AS item)
$$;

ALTER TABLE doctor_clinics
  ADD COLUMN specialty_codes text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE doctor_clinics
  ADD CONSTRAINT doctor_clinics_specialty_codes_count
    CHECK (cardinality(specialty_codes) <= 3 AND array_position(specialty_codes, NULL) IS NULL),
  ADD CONSTRAINT doctor_clinics_specialty_codes_unique
    CHECK (tabibi_text_array_has_no_duplicates(specialty_codes)),
  ADD CONSTRAINT doctor_clinics_specialty_codes_known
    CHECK (specialty_codes <@ ARRAY[
    'general_medicine',
    'pediatrics',
    'gynecology',
    'cardiology',
    'dermatology',
    'ophthalmology',
    'ent',
    'dentistry',
    'internal_medicine',
    'endocrinology',
    'gastroenterology',
    'pulmonology',
    'neurology',
    'psychiatry',
    'rheumatology',
    'orthopedics',
    'urology',
    'nephrology',
    'general_surgery',
    'physiotherapy'
    ]::text[]);
