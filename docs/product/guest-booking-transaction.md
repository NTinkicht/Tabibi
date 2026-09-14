# WU59 — Guest booking transaction from opaque availability reference

Parent epic: #2  
Issue: #250

## Goal

Allow an unauthenticated guest to turn a valid WU58 opaque availability selection into exactly one booked appointment and queue entry without exposing or trusting raw internal clinic, doctor, session, patient, tenant, membership, audit, or queue identifiers.

This slice is the mutation boundary between public discovery/availability and the existing appointment/guest-access foundations. It must preserve privacy, tenant isolation, idempotency, concurrency safety, Arabic/French locale handling, and current appointment-domain invariants.

## Authoritative inputs

The public client supplies an opaque WU58 selection reference plus bounded guest booking data. Raw clinic/doctor/session UUIDs are never authoritative public inputs.

The server must resolve and revalidate the selection against current durable truth inside the booking transaction. A reference that is expired, tampered, stale, points to an inactive clinic, no longer matches the doctor association/window, or targets a terminal session must fail closed before operational mutation.

## Public HTTP boundary

The application exposes `POST /api/public/bookings` as the guest mutation boundary. The JSON body is a strict allow-list containing only the opaque selection reference and bounded guest booking fields. The client supplies a bounded opaque `Idempotency-Key` header; request correlation uses the shared `x-request-id` convention and replaces unsafe caller values with a generated safe correlation identifier.

Expected validation, stale/tampered-reference, and idempotency-conflict failures serialize to the same generic public rejection shape so the route does not become an oracle for hidden selection or prior-booking state. Successful responses serialize only `serviceDate`, `startsAt`, `endsAt`, `queueLabel`, `guestBearer`, and `guestAccessExpiresAt`, and are marked `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

The WU58 selection encryption material is supplied through the protected runtime setting `PUBLIC_AVAILABILITY_SELECTION_SECRET` (minimum 32 bytes); it has no production source default and must not be logged or returned through public responses.

## Guest patient boundary

The booking flow may create the minimum clinic-scoped `patient_operational_records` row needed for the guest booking. It must not create an account user merely to complete a guest booking.

Public guest fields must be explicitly allow-listed and validated. At minimum the design must keep locale constrained to `ar` or `fr`, enforce contact-preference requirements, and avoid returning private display/contact fields.

## Atomic mutation

A successful request creates or binds one clinic-scoped patient operational record as required, one appointment, one queue entry, privacy-safe audit evidence, and one guest-access capability that can be used by the already-existing guest status path.

The mutation must be atomic. Failure after partial work must not leave orphan patient, appointment, queue, receipt, guest-capability, or audit state.

## Idempotency and concurrency

A bounded client-generated public idempotency key is required. The durable booking-receipt record must enforce a database-level uniqueness constraint scoped to the resolved clinic and idempotency key, and must persist a privacy-safe fingerprint of the material request used for replay comparison.

Same clinic/key plus a materially identical request must replay the same logical public result without creating additional patient, appointment, queue, capability, receipt, or audit state. Same clinic/key plus materially different input must return a generic conflict and create no additional state. The conflict response must not reveal whether or what prior booking exists, and must not expose any prior guest data.

Concurrent equivalent submissions must converge through the database uniqueness boundary rather than a check-then-insert race. The implementation must perform the receipt claim and operational mutation in the same transaction; when a concurrent unique conflict is observed, it must re-read the committed receipt, compare the privacy-safe request fingerprint, and return either the existing logical replay or the same generic conflict. A transaction failure before commit must roll back the receipt together with every operational mutation.

## Privacy

Public success/error responses must not serialize raw clinic, doctor, session, appointment, patient, queue, tenant, membership, audit, or account-user IDs. They must not echo private patient name/contact values or decrypted WU58 claims.

Audit metadata must record only what operators need to establish a guest/public booking event and correlation/idempotency lineage. Raw guest contact values and opaque selection claims must not be copied into audit metadata.

## Required executable evidence

PostgreSQL integration tests must prove:

1. a valid request creates exactly one logical patient/appointment/queue booking and usable guest capability;
2. expired, malformed, tampered, terminal, inactive-clinic, association-drift, and window-drift references cause zero operational mutation;
3. cross-clinic/doctor/session substitution cannot succeed;
4. identical idempotent replay returns the same logical result without duplicates;
5. changed material input under a reused key conflicts without extra mutation and without disclosing the original booking;
6. concurrent equivalent requests converge to one booking through the database uniqueness boundary;
7. locale and contact-preference validation are enforced;
8. failure during the transaction rolls back partial receipt and operational state;
9. public result/error serialization leaks none of the forbidden identifiers/private fields;
10. audit evidence is privacy-safe and identifies the source as guest/public;
11. tests are deterministic and have no external network dependency.

## Governance

Exactly one canonical stream: `wu59-guest-booking-transaction` and its single PR.

Initial material contract author: ChatGPT. Mechanical GitHub executor: ChatGPT connector. ChatGPT is recused from being the final non-author gate for materially authored work.

Mistral Vibe is the preferred routine first-pass exact-head reviewer when its included-capacity path is concretely operational. Every Medium+/Major+/High+/Critical/Blocker finding is merge-blocking until reconciled. This slice crosses privacy, capability, idempotency, and concurrency boundaries, so Claude is preferred for escalation/final gate when available. Codex and Copilot remain eligible complementary/failover actors subject to concrete capacity and authorship independence. Gemini CLI/Mistral unattended Issue #11 lanes remain read-only.

Zero-extra-cost only: no paid APIs, PAYG/overage/credits, Vertex, OpenRouter, auto-topups, or retired Gemini Agent/Chat.
