-- docs/design/pwa-push.md section 3: a guest who booked online holds a booking
-- bearer (poll, cancel, check-in) and may also hold a status-only credential
-- opened from a push link. The two classes coexist, one live credential of each
-- class per queue entry. Existing rows default to 'status'; every credential a
-- booking receipt points at is backfilled as 'booking'.
ALTER TABLE guest_credentials
  ADD COLUMN credential_class text NOT NULL DEFAULT 'status'
  CHECK (credential_class IN ('status', 'booking'));

UPDATE guest_credentials credential
   SET credential_class = 'booking'
 WHERE EXISTS (
   SELECT 1 FROM public_guest_booking_receipts receipt
    WHERE receipt.credential_id = credential.id
      AND receipt.clinic_id = credential.clinic_id);

DROP INDEX guest_credentials_one_live_per_entry_uq;

CREATE UNIQUE INDEX guest_credentials_one_live_per_entry_class_uq
  ON guest_credentials (queue_entry_id, credential_class)
  WHERE revoked_at IS NULL;
