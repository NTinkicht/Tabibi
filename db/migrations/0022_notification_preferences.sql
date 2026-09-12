CREATE TYPE notification_channel AS ENUM (
  'in_app',
  'push',
  'sms',
  'email',
  'whatsapp'
);

CREATE TYPE notification_preference_state AS ENUM ('enabled', 'disabled');

CREATE TYPE notification_consent_state AS ENUM (
  'not_required',
  'granted',
  'denied',
  'revoked'
);

CREATE TYPE notification_preference_subject_kind AS ENUM (
  'visit_patient',
  'account'
);

CREATE TABLE notification_preferences (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  subject_kind notification_preference_subject_kind NOT NULL,
  patient_id uuid,
  account_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  channel notification_channel NOT NULL,
  preference_state notification_preference_state NOT NULL,
  consent_state notification_consent_state NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, clinic_id),
  UNIQUE NULLS NOT DISTINCT (clinic_id, patient_id, account_user_id, channel),
  FOREIGN KEY (patient_id, clinic_id)
    REFERENCES patient_operational_records(id, clinic_id) ON DELETE RESTRICT,
  CHECK (
    (subject_kind = 'visit_patient' AND patient_id IS NOT NULL AND account_user_id IS NULL)
    OR
    (subject_kind = 'account' AND patient_id IS NULL AND account_user_id IS NOT NULL)
  ),
  CHECK (
    (channel = 'in_app' AND consent_state = 'not_required')
    OR
    (channel <> 'in_app' AND consent_state <> 'not_required')
  )
);

CREATE TABLE notification_preference_receipts (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL
    CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
  subject_kind notification_preference_subject_kind NOT NULL,
  patient_id uuid,
  account_user_id uuid,
  channel notification_channel NOT NULL,
  preference_state notification_preference_state NOT NULL,
  consent_state notification_consent_state NOT NULL,
  expected_revision bigint CHECK (expected_revision IS NULL OR expected_revision > 0),
  preference_id uuid NOT NULL,
  result_revision bigint NOT NULL CHECK (result_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, idempotency_key),
  FOREIGN KEY (patient_id, clinic_id)
    REFERENCES patient_operational_records(id, clinic_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CHECK (
    (subject_kind = 'visit_patient' AND patient_id IS NOT NULL AND account_user_id IS NULL)
    OR
    (subject_kind = 'account' AND patient_id IS NULL AND account_user_id IS NOT NULL)
  ),
  FOREIGN KEY (preference_id, clinic_id)
    REFERENCES notification_preferences(id, clinic_id) ON DELETE RESTRICT
);

CREATE INDEX notification_preferences_subject_idx
  ON notification_preferences (clinic_id, subject_kind, patient_id, account_user_id);
