-- TAB-P0-13 (#743): persisted guest-link notification intents. Only the
-- AAD-bound envelope ciphertext of link material is stored (never plaintext),
-- it lives at most 10 minutes (the exchange-ID TTL), and it is scrubbed to NULL
-- on every terminal outcome: delivered, dead_letter or expired.
CREATE TABLE guest_link_intents (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL,
  queue_entry_id uuid NOT NULL,
  intent text NOT NULL CHECK (intent IN ('initial', 'transfer', 'resend', 'recovery')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'dead_letter', 'expired')),
  envelope_ciphertext text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  scrubbed_at timestamptz,
  FOREIGN KEY (queue_entry_id, clinic_id)
    REFERENCES queue_entries(id, clinic_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK ((state = 'pending') = (envelope_ciphertext IS NOT NULL)),
  CHECK ((state = 'pending') = (scrubbed_at IS NULL))
);

CREATE INDEX guest_link_intents_pending_expiry_idx
  ON guest_link_intents (expires_at)
  WHERE state = 'pending';
