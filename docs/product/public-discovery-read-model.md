# WU56 — Public clinic and doctor discovery read model

Parent epic: #2

## Scope

This work unit introduces the first patient-facing discovery read model. It intentionally does not create, confirm, cancel, or mutate appointments and does not alter queue state.

## Public projection

A discovery result may expose only data deliberately intended for public discovery:

- clinic public name;
- clinic-supported locale metadata needed to render the public experience;
- associated doctor public display name;
- stable public identifiers specifically required to navigate to a discovery detail route.

The projection must not expose internal user IDs, tenant keys, clinic memberships, authorization roles, audit metadata, notification data, patient identifiers, contact secrets, clinical content, or raw database rows.

## Eligibility and isolation

- only `active` clinics are discoverable;
- doctors are returned only through their association with an eligible clinic;
- one clinic's doctor projection must never be assembled from another clinic's association rows;
- inactive clinics and their associated doctors must not appear in public discovery results;
- deterministic ordering is required so Arabic/French presentation and tests are stable across runs.

## Implementation boundaries

Reuse the existing `clinics`, `doctor_profiles`, and `doctor_clinics` persistence model. Do not duplicate clinic or doctor source-of-truth tables. Keep the public read model separate from clinic-authenticated administrative services so future discovery policy changes do not weaken staff authorization boundaries.

## Required executable evidence

Bounded PostgreSQL integration/API tests must prove:

1. at least two active clinics with distinct associated doctors produce non-vacuous results;
2. an inactive clinic is excluded;
3. doctors remain associated with the correct clinic result;
4. result ordering is deterministic under deliberately non-sorted fixture insertion;
5. serialized/public output contains none of the forbidden internal fields above;
6. no external provider or network SaaS is required.

## Merge gate

Exactly one canonical WU56 branch/PR. Exact-head CI must be green. Mistral Vibe should perform the routine first-pass exact-head review when the approved included-capacity path is concretely reachable. Any Medium+/Major+/High+/Critical/Blocker finding from any reviewer must be reconciled before merge. A materially independent eligible non-author reviewer must issue the final exact-head gate; escalate to Claude for security/privacy/architecture concerns or if Mistral evidence/scope accounting is inconsistent.

Zero-extra-cost only: no PAYG, overage, credits, Vertex, OpenRouter, paid API fallback, or auto-topups. Retired Gemini Agent/Chat remain unused.
