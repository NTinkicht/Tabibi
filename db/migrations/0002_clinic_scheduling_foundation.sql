CREATE TYPE clinic_status AS ENUM ('active', 'inactive');
CREATE TYPE membership_role AS ENUM ('doctor', 'receptionist', 'clinic_admin');
CREATE TYPE platform_role AS ENUM ('platform_admin');
CREATE TYPE session_status AS ENUM ('planned', 'open', 'paused', 'closed', 'cancelled');

CREATE TABLE users (
  id uuid PRIMARY KEY,
  auth_subject text NOT NULL UNIQUE,
  display_name text NOT NULL,
  platform_role platform_role,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clinics (
  id uuid PRIMARY KEY,
  tenant_key text NOT NULL UNIQUE CHECK (tenant_key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Africa/Algiers',
  default_locale text NOT NULL DEFAULT 'ar' CHECK (default_locale IN ('ar', 'fr')),
  enabled_locales text[] NOT NULL DEFAULT ARRAY['ar', 'fr']::text[],
  status clinic_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(enabled_locales) > 0),
  CHECK (enabled_locales <@ ARRAY['ar', 'fr']::text[]),
  CHECK (default_locale = ANY(enabled_locales))
);

CREATE TABLE clinic_memberships (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role membership_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, user_id)
);

CREATE TABLE doctor_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE doctor_clinics (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, doctor_id)
);

CREATE TABLE schedule_templates (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  local_start_time time NOT NULL,
  local_end_time time NOT NULL,
  occurrence_index smallint NOT NULL DEFAULT 0 CHECK (occurrence_index >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (clinic_id, doctor_id) REFERENCES doctor_clinics(clinic_id, doctor_id) ON DELETE CASCADE,
  UNIQUE (clinic_id, doctor_id, weekday, occurrence_index),
  UNIQUE (id, clinic_id, doctor_id, occurrence_index),
  CHECK (local_end_time > local_start_time)
);

CREATE TABLE consultation_sessions (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  template_id uuid,
  service_date date NOT NULL,
  template_occurrence smallint NOT NULL DEFAULT 0 CHECK (template_occurrence >= 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status session_status NOT NULL DEFAULT 'planned',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (clinic_id, doctor_id) REFERENCES doctor_clinics(clinic_id, doctor_id) ON DELETE RESTRICT,
  FOREIGN KEY (template_id, clinic_id, doctor_id, template_occurrence)
    REFERENCES schedule_templates(id, clinic_id, doctor_id, occurrence_index) ON DELETE RESTRICT,
  CHECK (ends_at > starts_at)
);

CREATE UNIQUE INDEX consultation_sessions_template_occurrence_uq
  ON consultation_sessions (clinic_id, doctor_id, service_date, template_id, template_occurrence)
  WHERE template_id IS NOT NULL;

-- This is the final database-level guard. Application transitions additionally take
-- a doctor-keyed transaction advisory lock to serialize open/resume attempts.
CREATE UNIQUE INDEX consultation_sessions_one_open_per_doctor_uq
  ON consultation_sessions (doctor_id) WHERE status = 'open';

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  entity_type text NOT NULL CHECK (entity_type IN ('clinic', 'membership', 'doctor', 'schedule_template', 'consultation_session')),
  entity_id uuid NOT NULL,
  action text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_clinic_time_idx ON audit_events (clinic_id, occurred_at DESC);
CREATE INDEX consultation_sessions_clinic_date_idx ON consultation_sessions (clinic_id, service_date);
