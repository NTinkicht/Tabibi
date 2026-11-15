-- Guest Web Push subscription bindings (docs/design/pwa-push.md section 3).
-- The subscription (endpoint and keys) is stored only as an AES-GCM envelope
-- and is looked up only through a keyed hash. A revoked or expired row keeps
-- no sealed material.
CREATE TABLE guest_push_subscriptions (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  queue_entry_id uuid NOT NULL,
  endpoint_hash text NOT NULL CHECK (endpoint_hash ~ '^[0-9a-f]{64}$'),
  sealed_subscription text,
  locale text NOT NULL CHECK (locale IN ('ar', 'fr')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text
    CHECK (revocation_reason IN
      ('unsubscribed', 'expired', 'gone', 'terminal', 'rotated')),
  FOREIGN KEY (queue_entry_id, clinic_id)
    REFERENCES queue_entries(id, clinic_id) ON DELETE RESTRICT,
  CONSTRAINT guest_push_subscriptions_expiry_order CHECK (expires_at > created_at),
  CONSTRAINT guest_push_subscriptions_expiry_max CHECK (
    expires_at <= created_at + interval '24 hours'),
  CONSTRAINT guest_push_subscriptions_state CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL
      AND sealed_subscription IS NOT NULL AND length(sealed_subscription) > 0)
    OR
    (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL
      AND sealed_subscription IS NULL AND revoked_at >= created_at)
  ),
  UNIQUE (id, clinic_id)
);

CREATE UNIQUE INDEX guest_push_subscriptions_active_endpoint_uq
  ON guest_push_subscriptions (endpoint_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX guest_push_subscriptions_entry_active_idx
  ON guest_push_subscriptions (clinic_id, queue_entry_id)
  WHERE revoked_at IS NULL;
