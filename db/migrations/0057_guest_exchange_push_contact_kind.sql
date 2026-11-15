-- Guest exchanges may be issued by the system to a verified push subscription
-- (docs/design/pwa-push.md section 3). Every other issuance keeps requiring a
-- staff actor.
ALTER TABLE guest_exchange_ids
  DROP CONSTRAINT guest_exchange_ids_contact_kind_check;
ALTER TABLE guest_exchange_ids
  ADD CONSTRAINT guest_exchange_ids_contact_kind_check
  CHECK (contact_kind IN ('phone', 'email', 'push'));
ALTER TABLE guest_exchange_ids
  ALTER COLUMN issued_by_user_id DROP NOT NULL;
ALTER TABLE guest_exchange_ids
  ADD CONSTRAINT guest_exchange_ids_issuer_required
  CHECK (contact_kind = 'push' OR issued_by_user_id IS NOT NULL);
