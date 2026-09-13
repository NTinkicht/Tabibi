# notification-domain

This directory owns the **notification-domain** module boundary. Its domain,
application, and adapter code must expose intentional public APIs rather than
importing another module's internals.

The provider-neutral outbox persists the result of a claimed dispatch attempt as
`delivered`, retryable `failed`, `unknown`, terminal `dead_letter`, or terminal
`suppressed`. Retryable outcomes use deterministic attempt-based delays (1 minute,
5 minutes, 15 minutes, 1 hour, then 4 hours), and a claim is rejected until
`next_attempt_at` is due. Completion at the configured maximum attempt atomically
becomes `dead_letter`. Every completion is clinic-scoped and fenced by the current
claim token and lease expiry, so a superseded intent or stale worker cannot publish
a late outcome.

`NotificationDispatchService` is the provider-neutral application boundary for
one dispatch attempt. It claims one specific persisted intent, then resolves the
current WU27 delivery target and preference/consent **after the exact claim and
immediately before provider execution**. Missing, disabled, denied, revoked, or
mismatched authorization fails closed: the provider adapter is never invoked and
the exact claim is completed as terminal `suppressed` with one bounded categorical
reason code. Delivery-context resolver failures are classified as the bounded
`delivery_context_failure` retryable outcome and completed through the same
claim-fenced retry/dead-letter lifecycle, so repeated failures cannot strand an
intent outside normal terminal/operator-visible progression. Exception messages
are never persisted or emitted.

When authorization is valid, WU30 renders a bounded provider-neutral envelope only
after the authorization decision and before provider invocation. The envelope may
contain the rendered notification `title` and `body`, locale/direction, template id,
channel, and provider idempotency key. Raw contact destinations, bearer material,
provider credentials, claim tokens, arbitrary clinical payload fields, and patient
identity data are not part of this provider boundary. Renderer failures are also
classified as bounded retryable outcomes and never invoke the provider.

The authorization resolver is intentionally provider-neutral. A
`NotificationDeliveryTargetResolver` supplies only a clinic-local subject identity
kind/id and channel; `NotificationPreferenceDeliveryContextResolver` then loads
the latest WU27 preference through its public repository contract and reuses
`isNotificationDeliveryEligible` for the final decision.

There is one unavoidable external-send race: once the final authorization check
has passed and a real provider invocation has started, a later consent change
cannot retroactively unsend that external request. Future real adapters must keep
this last-moment gate immediately before invocation and retain provider
idempotency/fencing so the window is bounded and auditable.

Provider adapters receive a deterministic idempotency key derived only from the
immutable notification intent identifier. The same logical intent therefore uses
the same provider key across retries, including retries after `unknown`, provider
exceptions, or expired claims, so a provider that accepted an earlier request can
deduplicate a later retry. Payload content and attempt counters are not included
in that key. WU24 intentionally defines no real SMS, WhatsApp, push, credential,
scheduler, or network implementation; those remain later bounded slices behind
this contract.

For `turn_approaching`, new producers must persist the canonical numeric `position`
field. The renderer temporarily accepts legacy `places` as a read-only compatibility
alias for already-existing fixtures/intents; it must not be emitted by new producer
code. `queue_entry_transferred` deliberately fails closed until the dedicated secure
post-decryption exchange-link composition is injected, preventing a transfer from
being reported delivered without the guest's replacement access path.

WU32 introduces `QueueNotificationProducer` as the single production-facing
boundary from already-authoritative queue lifecycle events into the durable outbox.
It supports only `queue_entry_created`, `estimate_changed_materially`,
`turn_approaching`, `patient_called`, and `queue_entry_cancelled`. Each source event
uses `queue-event:<sourceEventId>` as its clinic-scoped idempotency key, the queue
entry as its logical target, and the authoritative source version as the outbox
intent version. Replaying the same source event therefore returns the same persisted
intent, while a stale version is rejected by the existing outbox ordering rules.
Newer intents supersede only states already eligible for supersession in the outbox;
terminal intents are never rewritten or revived. Guest `queue_entry_transferred`
and every other unsupported lifecycle event fail closed before persistence.

The WU32 producer owns no destination or contact lookup, consent decision,
rendering, provider call, credential, or external network dependency. Producer
payloads remain deliberately bounded and use canonical `position`, never legacy
`places`. PostgreSQL integration coverage verifies replay/idempotency,
supersession/stale rejection, clinic isolation, and guest-transfer fail-closed
behavior through the real outbox repository.

WU25 adds a deterministic, clinic-scoped discovery and bounded execution layer.
`NotificationDispatchEligibilityRepository` returns only intent identifiers and
their eligibility timestamp; it never returns notification payloads. It excludes
terminal/superseded/suppressed intents, exhausted attempt budgets, not-yet-due
retries, and active unexpired claims, then orders eligible rows by due time with
stable persisted tie breakers. Batch size is explicitly bounded to 1-100 intents.

`NotificationDispatchBatchRunner` consumes that read-only scan and invokes the
existing single-intent dispatch boundary once per selected identifier. Selection
is not ownership: concurrent runners still race through the WU21 atomic claim
fence, so a losing runner records `notClaimed` rather than creating a second
ownership mechanism. Each selected item is isolated: an unexpected executor
exception increments the aggregate `errors` counter and does not prevent later
selected intents from running. The returned batch summary contains aggregate
counts only (`selected`, `completed`, `suppressed`, `notClaimed`, `claimLost`,
`errors`) and therefore does not expose provider payloads, exception messages, or
patient-sensitive notification data. WU25/WU31 deliberately add no timer, cron
process, daemon, queue consumer, real provider network call, or cross-clinic
scheduler.

## Operational observability contract

Dispatch services accept a `NotificationDispatchObserver` and emit synchronous,
structured metadata-only events after each authoritative result. Single-intent
events distinguish `not_claimed`, `claim_lost`, and persisted outcomes including
`suppressed`. Persisted outcomes expose the attempt/max-attempt counters plus
`retryScheduled` and `exhausted`, allowing retry, suppression, and dead-letter
alerts without reading payloads. Bounded runs emit one clinic-scoped aggregate
containing only selected/completed/suppressed/not-claimed/claim-lost/error counts.
The default observer is an explicit no-op so the domain remains independent of a
metrics or logging vendor.

The schema deliberately permits only clinic and intent identifiers, fixed
categorical outcomes, bounded suppression reason codes, and numeric/boolean
counters. It excludes payloads, event content, patient/queue identities, phone
numbers, provider codes, claim tokens, provider idempotency keys, credentials, and
exception messages. These operational events are not written to `audit_events`;
audit history remains a separate module.
