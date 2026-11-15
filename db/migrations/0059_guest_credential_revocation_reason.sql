-- Records why a guest status credential was revoked (docs/design/pwa-push.md
-- section 3, credential rotation for push exchanges). Existing revocations
-- keep a NULL reason.
ALTER TABLE guest_credentials
  ADD COLUMN revocation_reason text;
ALTER TABLE guest_credentials
  ADD CONSTRAINT guest_credentials_revocation_reason_check
  CHECK (revocation_reason IS NULL
    OR (revoked_at IS NOT NULL AND revocation_reason IN ('rotated')));
