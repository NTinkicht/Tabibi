# Privacy-Constrained Product Analytics Contract

Status: WU53 release-hardening contract under Epic #7.

## Purpose

Tabibi may measure whether the product is reliable and usable without building patient or clinical profiles. Analytics is therefore allowlist-based: an event or dimension that is not explicitly approved here is prohibited from product analytics.

This contract does not authorize new third-party telemetry infrastructure. Existing repository-controlled application/database/logging mechanisms remain the only permitted evidence path for this work unit.

## Principles

1. Measure product and operational behavior, not a person's health or identity.
2. Prefer counts, rates, durations, bounded status categories, and coarse aggregate dimensions.
3. Do not create stable patient-level behavioral histories for analytics.
4. Clinic isolation remains mandatory. No cross-clinic person-level joining or comparison is permitted.
5. Analytics payload construction is fail-closed: unknown/unapproved fields must be rejected or dropped before persistence/export.
6. Production diagnostics and analytics must never be treated as a substitute for clinical records.

## Allowed metric families

Only the following metric families are release-approved, subject to the dimension restrictions below.

| Metric family | Allowed examples | Privacy rationale |
| --- | --- | --- |
| Queue operations | counts of check-ins, calls, no-shows, cancellations, completed consultations; aggregate queue depth | operational state only; no diagnosis or patient profile required |
| Timing/reliability | aggregate wait duration, ETA error distribution, request latency, retry/failure counts | measures system performance rather than clinical characteristics |
| Product flow | aggregate completion/drop-off counts for booking, check-in, receptionist actions and language-mode flow | measures usability when kept aggregate and identity-free |
| Notification operations | queued/sent/failed/unknown outcome counts and retry counts | provider/system health only; delivery content and contact destination are excluded |
| Release quality | CI pass/fail counts, acceptance-test outcomes, recovery/load/fault-test measurements | engineering/release evidence without patient data |
| Localization/accessibility | aggregate Arabic/French mode usage, RTL/LTR rendering/test outcomes, keyboard-path completion counts | product-mode quality only; no person-level language profile |

## Allowed dimensions

A metric may use only dimensions needed to interpret product/reliability behavior, such as:

- bounded workflow/status category;
- application surface or endpoint family;
- Arabic/French UI mode;
- broad client class such as mobile/desktop where already available without fingerprinting;
- release/application version;
- coarse time bucket;
- clinic-scoped aggregate identifier only when required for that clinic's own operational view and never for cross-clinic person profiling.

Dimensions must not enable reconstruction of a patient identity or longitudinal clinical/behavioral profile.

## Explicit denylist

Product analytics must not contain or derive:

- diagnosis, condition, symptom, medication, treatment, clinical notes, reason-for-visit free text, or other clinical content;
- patient name, phone, email, address, government identifier, date of birth, or contact destination;
- raw patient, dependent, queue-entry, booking, consultation, notification, request, or audit UUIDs/IDs when used to identify an individual;
- free-text search, free-text form content, message bodies, notification bodies, or log payloads that may carry user-entered content;
- precise geolocation, device fingerprint, advertising identifier, or cross-site tracking identifier;
- stable pseudonymous patient identifiers intended to join behavior across sessions/days;
- cross-clinic joins at patient/person level;
- inferred health, socioeconomic, ethnicity, religion, disability, or other sensitive-person attributes;
- ranking/scoring of individual patients, clinics, doctors, or staff for behavioral or clinical profiling.

## Aggregation and small-cohort handling

Analytics intended for dashboards, exports, or release decisions should be aggregate-first.

- Prefer daily or larger time buckets unless a shorter bucket is required for live operational health.
- Do not expose a slice that effectively singles out one patient/person through combined dimensions.
- Suppress, merge, or omit unusually small cohort slices where re-identification risk becomes material.
- Operational debugging may use request/correlation identifiers only in the existing privacy-minimal diagnostic path; those identifiers are not product-analytics dimensions and must not become a behavioral profile key.

## Retention and minimization

- Collect only fields needed for an approved metric.
- Do not duplicate clinical/business records into an analytics store merely for convenience.
- Retain analytics only as long as needed for operational/product trend analysis and release validation; shorter retention is preferred when equivalent evidence is available.
- Any future retention increase or new dimension requires an explicit reviewed change to this allowlist.

## Event/payload enforcement

Any future analytics emitter must have a repository-controlled schema or equivalent explicit field allowlist. Tests must prove that representative forbidden fields are rejected/dropped, including clinical text, contact information, stable patient identifiers, and arbitrary extra properties.

An implementation that serializes an unconstrained application/domain object into analytics is non-compliant even if current callers happen not to populate sensitive fields.

## Release sign-off evidence

WU53 is complete only when the candidate exact head demonstrates:

1. this allowlist/denylist is repository-controlled;
2. any analytics implementation introduced by the work unit has negative tests for forbidden fields and cross-patient/cross-clinic leakage;
3. existing CI is green on the exact final head;
4. one eligible non-author reviewer explicitly confirms the exact head does not introduce clinical/patient profiling or unnecessary identifiers;
5. `docs/release/release-readiness-matrix.md` (or its current successor) marks the analytics gap PASS only after that evidence exists.

## Cost and provider boundary

WU53 must not add paid telemetry/analytics SaaS, paid APIs, PAYG/overage, credits, Vertex, OpenRouter, auto-topups, or retired Gemini Agent/Chat paths. If useful analytics cannot be implemented safely with included/local/repository-controlled capacity, the metric is deferred rather than bypassing this boundary.

## Authorship and final gate

Material author: ChatGPT.
Mechanical GitHub executor: ChatGPT connector.

Because ChatGPT authored this contract, ChatGPT is ineligible to be the sole final gate for the exact implementation head. Preserve at least one eligible non-author final reviewer.