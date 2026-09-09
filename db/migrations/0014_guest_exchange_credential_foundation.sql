CREATE TABLE guest_exchange_ids (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL,
  queue_entry_id uuid NOT NULL,
  exchange_verifier text NOT NULL UNIQUE CHECK (length(exchange_verifier) = 64),
  purpose text NOT NULL DEFAULT 'initial_access'
    CHECK (purpose IN ('initial_access')),
  contact_kind text NOT NULL CHECK (contact_kind IN ('phone', 'email')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  FOREIGN KEY (session_id, clinic_id)
    REFERENCES consultation_sessions(id, clinic_id) ON DELETE RESTRICT,
  FOREIGN KEY (queue_entry_id, clinic_id)
    REFERENCES queue_entries(id, clinic_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '10 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  UNIQUE (id, clinic_id)
);

CREATE INDEX guest_exchange_ids_target_active_idx
  ON guest_exchange_ids (clinic_id, session_id, queue_entry_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE guest_credentials (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL,
  queue_entry_id uuid NOT NULL,
  bearer_verifier text NOT NULL UNIQUE CHECK (length(bearer_verifier) = 64),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (session_id, clinic_id)
    REFERENCES consultation_sessions(id, clinic_id) ON DELETE RESTRICT,
  FOREIGN KEY (queue_entry_id, clinic_id)
    REFERENCES queue_entries(id, clinic_id) ON DELETE RESTRICT,
  CHECK (expires_at > issued_at),
  CHECK (expires_at <= issued_at + interval '24 hours'),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  UNIQUE (id, clinic_id)
);

CREATE UNIQUE INDEX guest_credentials_one_live_per_entry_uq
  ON guest_credentials (queue_entry_id)
  WHERE revoked_at IS NULL;

CREATE INDEX guest_credentials_target_lookup_idx
  ON guest_credentials (clinic_id, session_id, queue_entry_id, expires_at)
  WHERE revoked_at IS NULL;
