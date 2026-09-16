CREATE TYPE dependent_status AS ENUM ('active', 'archived');

CREATE TABLE patient_dependents (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  status dependent_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK (display_name = btrim(display_name)),
  CHECK (
    display_name = regexp_replace(
      display_name,
      U&'^[[:space:]\00A0\1680\2000-\200A\2028\2029\202F\205F\3000]+|[[:space:]\00A0\1680\2000-\200A\2028\2029\202F\205F\3000]+$',
      '',
      'g'
    )
  ),
  CHECK (char_length(display_name) BETWEEN 1 AND 160),
  CHECK (display_name IS NFC NORMALIZED),
  CHECK (display_name !~ '[[:cntrl:]]'),
  CHECK (
    display_name !~ U&'[\00AD\0600-\0605\061C\06DD\070F\0890-\0891\08E2\180E\200B-\200F\202A-\202E\2060-\2064\2066-\206F\FEFF\FFF9-\FFFB\+0110BD\+0110CD\+013430-\+01343F\+01BCA0-\+01BCA3\+01D173-\+01D17A\+0E0001\+0E0020-\+0E007F]'
  ),
  CHECK (
    (status = 'active' AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL)
  )
);

CREATE INDEX patient_dependents_owner_status_name_idx
  ON patient_dependents (owner_user_id, status, display_name, id);

CREATE INDEX patient_dependents_owner_updated_idx
  ON patient_dependents (owner_user_id, updated_at DESC, id);

COMMENT ON TABLE patient_dependents IS
  'Operational dependent identities owned by authenticated patient accounts; no clinical data.';
COMMENT ON COLUMN patient_dependents.owner_user_id IS
  'Server-authoritative owner scope; never expose this identifier through dependent API responses.';
