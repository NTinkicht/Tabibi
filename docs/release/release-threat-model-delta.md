# Release threat-model delta

This WU51 artifact refreshes Tabibi's release threat model against the stabilized Epic #7 release-acceptance surface after WU46-WU50. It is deliberately evidence-bound: a control is treated as present only when the repository contains an inspectable implementation, test, or release rehearsal. Residual risk is stated rather than hidden.

No real patient data, production credentials, external provider traffic, paid APIs, PAYG/overage/credits, Vertex, OpenRouter, auto-topups, or retired Gemini Agent/Chat are part of this assessment.

## Release trust boundaries

1. **Patient / guest browser -> application boundary**: untrusted localized browser input enters authenticated or guest-safe application routes. Mutation inputs, locale/directionality, refresh/retry behavior, and identifier exposure are security-relevant.
2. **Receptionist / clinic-staff browser -> clinic-scoped application boundary**: authenticated staff can perform higher-impact queue and notification operations, but authority must remain clinic-scoped and role-scoped.
3. **Public waiting-room display -> public observer boundary**: the display is intentionally unauthenticated/public-facing and therefore must reveal only privacy-safe display labels and operational state required for queue awareness.
4. **Application -> PostgreSQL boundary**: durable queue, patient, membership, notification, idempotency, and audit state is authoritative. Transaction, tenant scoping, persistence-failure handling, and deterministic recovery are critical.
5. **Application -> notification dispatch boundary**: provider/store failures must not become false delivery. Dispatch attempts and operational diagnostics must remain bounded and privacy-minimal.
6. **Operator / CI -> recovery and release tooling boundary**: backup/restore, load rehearsal, fault injection, and release acceptance are non-production guarded workflows. They must fail closed against production targets and avoid sensitive payload logging.

## Threat and abuse-case matrix

| Threat / abuse case | Boundary | Existing release evidence | Residual risk / release disposition |
| --- | --- | --- | --- |
| Cross-clinic queue read or mutation | Patient/staff -> application; application -> PostgreSQL | WU46 two-clinic lifecycle/isolation integration coverage; WU47-WU49 bilingual/public isolation assertions | **Low residual** if exact-head CI remains green. Any route added after this delta requires equivalent clinic-scope enforcement and negative tests. |
| Cross-patient/private identifier disclosure on public display | Public waiting-room | WU47 and WU49 assert a real rendered public label while private name, patient UUID, and queue-entry UUID remain absent | **Low residual** for covered release path. New public fields are security-sensitive and require explicit allowlisting. |
| Vacuous privacy test passes because no row rendered | Public waiting-room | WU49 remediation requires positive, non-vacuous public-row rendering before negative privacy assertions | **Mitigated** in release acceptance. Preserve positive proof requirement in future tests. |
| Malformed clinic identifier reaches database/membership logic or mutates dispatch state | Staff -> application | WU41 UUID validation and non-vacuous no-mutation regression | **Low residual** for covered dispatch route. Maintain validation before authorization/storage lookups on new routes. |
| Replay / duplicate mutation after slow refresh or reconnect | Patient/staff browser -> application | WU50 delayed-response / refresh acceptance verifies single mutation issuance, durable convergence, terminal-state non-regression, and notification-outbox stability | **Low residual** for exercised flow; server-side idempotency remains the authoritative defense where available. Client behavior alone must never be treated as sufficient. |
| Cross-clinic stale UI state after reconnect | Browser -> application | WU50 refresh acceptance includes cross-clinic absence assertions after delayed local response and refresh | **Low residual** in covered flow. Avoid shared client caches that are not keyed by clinic/user scope. |
| Notification provider throws but system reports delivered | Application -> notification provider/store | WU44 fault injection normalizes provider exceptions and rejects false success; notification fault matrix documents recovery ownership | **Mitigated** for covered dispatcher. External provider semantics remain a deployment-time dependency and require bounded timeout/retry configuration. |
| Inbox/store persistence failure is reported as successful delivery | Application -> PostgreSQL | WU44 persistence fault tests require the failure to surface instead of becoming delivered | **Mitigated** in covered path. Do not convert persistence exceptions into success-like operational states. |
| Claim/store failure invokes provider without durable ownership | Application -> dispatch store/provider | WU44 claim-failure test proves provider is not invoked when claim persistence fails | **Mitigated**. Preserve claim-before-provider ordering. |
| Completion persistence fails after provider call and is silently treated as success | Application -> dispatch store/provider | WU44 completion-failure test requires the post-provider persistence fault to surface | **Residual Medium operational ambiguity** is inherent when a provider may have accepted a message but durable completion recording fails. Release behavior must retain an explicit uncertain/reconcilable state and must not blindly re-send without idempotency/reconciliation controls. This is not a confidentiality break but is operationally security-relevant. |
| Operational diagnostics leak patient/contact/clinical content | Application/operator/CI | WU40/WU41 bounded dispatch/dead-letter observability; WU43 load harness emits aggregate-only metrics; WU44 exception normalization avoids raw exception text | **Low residual** if log/metric additions remain allowlisted and aggregate. No payload/body/contact/clinical text should enter release telemetry by default. |
| Load/recovery tooling accidentally targets production | Operator/CI -> PostgreSQL/tooling | WU43 explicit opt-in, production refusal, non-production database-name allowlist; existing guarded backup/restore rehearsal | **Mitigated** for current tools. Any new destructive/rehearsal command must inherit fail-closed environment and target guards. |
| Queue behavior diverges across Arabic RTL and French LTR paths | Browser/application | WU47-WU50 exercise Arabic/French acceptance against the same queue/isolation semantics | **Low security residual**. Localization must not create authorization or data-shaping forks. |
| Keyboard/accessibility path exposes different authorization behavior | Receptionist browser -> application | WU48 receptionist keyboard/semantic acceptance exercises the real operational surface | **Low residual**. Accessibility controls should invoke the same application actions as pointer interaction. |
| CI/reviewer evidence is stale relative to merge head | Release governance | Existing exact-head CI + expected-head merge discipline; non-author final gate required | **Process-controlled**. Any head mutation invalidates prior CI/review evidence. |

## Security invariants for release

The release candidate is security **NO-GO** if any of these invariants fails:

- clinic-scoped data or mutation authority crosses tenant boundaries;
- a public waiting-room surface exposes patient names, internal patient IDs, queue-entry IDs, contact details, or clinical content;
- a malformed or unauthorized mutation can create a durable side effect;
- retry/refresh behavior can duplicate a release-critical mutation or regress a terminal queue state;
- notification persistence/provider/store faults can be represented as confirmed delivery without durable evidence;
- operational logs, metrics, dead-letter views, or load-test output include unnecessary patient/contact/clinical payloads;
- rehearsal/recovery/load tooling can target production without an explicit fail-closed barrier;
- exact-head CI is not green or an eligible non-author reviewer reports an unresolved Medium+/Major+/High+/Critical/Blocker security finding.

## Residual-risk decisions

### Notification completion ambiguity

A provider may accept a notification before completion-state persistence fails. The system cannot safely infer either confirmed delivery or confirmed non-delivery from that state. The release-safe rule is therefore:

- surface a bounded operationally uncertain/reconcilable state;
- retain idempotency/reconciliation evidence where supported;
- never claim confirmed delivery solely from the provider call returning before durable completion state exists;
- never blindly retry in a way that knowingly creates duplicate-message risk.

This residual is acceptable for release only while the current fault-injection behavior and privacy-minimal diagnostics remain green and no reviewer identifies a path that falsely reports confirmed delivery.

## Follow-up boundaries

The next Epic #7 release-hardening artifacts remain separate bounded work units rather than being silently folded into this threat-model sign-off:

1. deterministic deployment/cutover/rollback runbook and post-rollback verification;
2. explicit product-analytics allowlist and negative constraints preventing clinical profiling;
3. final release matrix refresh marking evidence PASS only after exact-head CI and independent review.

## WU51 gate

This document is not self-approving release evidence. WU51 is merge-eligible only when:

- exact-head required CI is green;
- an eligible non-author reviewer checks this matrix against the actual repository surface and reports no unresolved Medium+/Major+/High+/Critical/Blocker finding;
- any material finding is reconciled on this same canonical branch/PR, after which CI and review are repeated on the new exact head.
