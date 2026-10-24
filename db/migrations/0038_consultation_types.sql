-- TAB-P0-02 (#651): clinic-scoped consultation types with nominal durations.
-- A consultation type is clinic configuration, not a clinical record: a stable
-- machine code, a short staff-facing label and a nominal duration in minutes.
-- Retired types stay as rows (active = false) so later references keep meaning.
CREATE TABLE consultation_types (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80 AND label = btrim(label)),
  nominal_duration_minutes integer NOT NULL
    CHECK (nominal_duration_minutes BETWEEN 5 AND 240),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, code)
);
