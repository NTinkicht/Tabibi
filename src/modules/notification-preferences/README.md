# Notification preference and consent boundary

Preferences are clinic-scoped to either a visit patient record or an account ID.
An unlinked guest uses `(clinic_id, patient_operational_records.id)` and therefore
starts with no consent on a later registration by design. Only an account-linked
patient may use `(clinic_id, account_user_id)` across visits. Contact-derived
identifiers (including hashes), queue-entry IDs, guest bearer credentials,
exchange IDs, contact values, provider data and clinical data never form part of
this model.

This repository is an internal persistence boundary, not an authorization API.
Callers that record a grant must first prove either an authenticated patient's
own action or an authorized staff recording of the patient's expressed choice.
Any future guest-facing mutation must reuse `GuestAccessService.authorize` and
its active-entry, expiry, revocation and terminal-grace rules. A caller must not
interpret possession of a subject ID, bearer verifier or stale credential as
authority to grant consent.

`in_app` is enabled without regulatory contact consent (`not_required`). Every
external channel (`push`, `sms`, `email`, `whatsapp`) is fail-closed unless a
stored preference is both `enabled` and `granted`. Missing records are therefore
ineligible. Future provider adapters must load the clinic-scoped record and call
`isNotificationDeliveryEligible` immediately before dispatch. This boundary does
not alter the existing provider-neutral outbox or its dispatch behavior.

Mutations serialize per clinic/subject/channel, support optimistic revisions and
store privacy-minimal idempotency receipts. Exact retries return the persisted
record without incrementing its revision; reuse of a key for different input and
stale revisions fail explicitly. A state-changing update must include the
current revision; a same-state retry remains a safe no-op. Consent may be
initially granted or denied,
granted consent may be revoked, and any state may be replaced by an explicit new
grant. Other consent transitions are rejected.
