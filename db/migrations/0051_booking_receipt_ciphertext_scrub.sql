-- Replay ciphertext of a booking receipt is scrubbed once its credential
-- is expired or revoked. The idempotency fingerprint row is retained.
ALTER TABLE public_guest_booking_receipts
  ADD COLUMN scrubbed_at timestamptz;

ALTER TABLE public_guest_booking_receipts
  DROP CONSTRAINT public_guest_booking_receipts_check;

ALTER TABLE public_guest_booking_receipts
  ADD CONSTRAINT public_guest_booking_receipts_state_check CHECK (
    (completed_at IS NULL AND patient_id IS NULL AND queue_entry_id IS NULL
      AND appointment_id IS NULL AND credential_id IS NULL
      AND access_ciphertext IS NULL AND scrubbed_at IS NULL)
    OR
    (completed_at IS NOT NULL AND patient_id IS NOT NULL AND queue_entry_id IS NOT NULL
      AND appointment_id IS NOT NULL AND credential_id IS NOT NULL
      AND ((access_ciphertext IS NOT NULL AND scrubbed_at IS NULL)
        OR (access_ciphertext IS NULL AND scrubbed_at IS NOT NULL)))
  );
