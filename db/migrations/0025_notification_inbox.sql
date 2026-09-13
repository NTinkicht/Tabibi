CREATE TABLE notification_inbox_items (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  subject_kind notification_preference_subject_kind NOT NULL,
  patient_id uuid,
  account_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  provider_idempotency_key text NOT NULL
    CHECK (length(btrim(provider_idempotency_key)) BETWEEN 1 AND 160),
  template_id text NOT NULL CHECK (length(btrim(template_id)) BETWEEN 1 AND 128),
  locale text NOT NULL CHECK (length(btrim(locale)) BETWEEN 1 AND 16),
  direction text NOT NULL CHECK (direction IN ('ltr', 'rtl')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, provider_idempotency_key),
  FOREIGN KEY (patient_id, clinic_id)
    REFERENCES patient_operational_records(id, clinic_id) ON DELETE RESTRICT,
  CHECK (
    (subject_kind = 'visit_patient' AND patient_id IS NOT NULL AND account_user_id IS NULL)
    OR
    (subject_kind = 'account' AND patient_id IS NULL AND account_user_id IS NOT NULL)
  )
);

CREATE INDEX notification_inbox_subject_created_idx
  ON notification_inbox_items (
    clinic_id,
    subject_kind,
    patient_id,
    account_user_id,
    created_at DESC,
    id DESC
  );
