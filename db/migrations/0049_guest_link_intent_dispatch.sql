-- TAB-P0-13 (#745): dispatch bookkeeping for guest-link intents. A worker
-- claims a due pending row under a lease, counts attempts and schedules a
-- bounded retry. Terminal states still scrub the ciphertext via 0048 CHECKs.
ALTER TABLE guest_link_intents
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN claimed_until timestamptz,
  ADD COLUMN claim_token uuid;

CREATE INDEX guest_link_intents_due_idx
  ON guest_link_intents (next_attempt_at NULLS FIRST, created_at)
  WHERE state = 'pending';
