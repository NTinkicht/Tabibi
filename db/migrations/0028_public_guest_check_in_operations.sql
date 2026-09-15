-- WU65: durable operation-identity idempotency record for capability-bound
-- guest check-in. Scoped to the authorized guest credential, which maps
-- 1:1 to exactly one booking/queue entry, so (credential_id, operation_id)
-- is the authorized-booking-scoped uniqueness boundary the contract requires.
-- Booking-level lifecycle serialization for concurrent same/distinct
-- operation identities is provided by the existing per-credential
-- pg_advisory_xact_lock in PublicGuestBookingCheckInService, not by this
-- table; this table exists for durable replay detection across separate
-- transactions/requests.

CREATE TABLE public_guest_check_in_operations (
  credential_id uuid NOT NULL REFERENCES guest_credentials(id) ON DELETE RESTRICT,
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, operation_id)
);
