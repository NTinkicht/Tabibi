# WU57 — Public doctor availability read model

Parent epic: #2
Issue: #246

## Goal

Extend the merged public clinic/doctor discovery read model with a bounded public availability projection that a future patient booking flow can consume. This slice is read-only: it must not create appointments, generate sessions, mutate queue state, or weaken staff scheduling/booking authorization.

## Source of truth

Reuse the existing `consultation_sessions`, `clinics`, `doctor_clinics`, and doctor profile relationships. Do not add an availability cache/table or derive availability from client-side assumptions.

The existing appointment domain currently accepts bookings only into sessions whose state is `planned`, `open`, or `paused`, and requires the requested appointment window to stay inside the session window. The public read model must stay compatible with those domain constraints rather than advertising terminal sessions.

## Public projection

A public availability item may expose only fields needed to present a bookable session window, for example:

- service date;
- public start/end timestamp or localized display window;
- a non-sensitive opaque navigation token only if a later booking route truly requires one.

The public projection must not expose raw clinic IDs, doctor IDs, session IDs by default, schedule-template IDs, tenant keys, user IDs, membership/role data, queue contents/state, patient data, audit metadata, or raw database rows.

If a stable public identifier becomes necessary, it must be intentionally designed and separately reviewed; internal UUIDs are not automatically public identifiers.

## Eligibility and isolation

A returned session must satisfy all of the following:

1. its clinic is active;
2. the requested doctor is actually associated with that clinic;
3. the session belongs to that same clinic and doctor association;
4. the session is future-facing for discovery and is not in a terminal state;
5. no read path causes session generation or any other mutation.

Same-name clinics and same-name doctors must remain isolated by internal identity server-side even though those internal identities are never serialized publicly.

## Determinism

Results must be ordered chronologically by the actual session start, with an internal stable tie-breaker in SQL so repeated reads are deterministic. Test fixtures must be inserted deliberately out of order.

## Required executable evidence

Bounded PostgreSQL integration tests must prove:

1. at least one active clinic/doctor pair returns non-vacuous future availability;
2. inactive clinics are excluded;
3. terminal sessions are excluded;
4. a doctor/session from another clinic cannot bleed into the requested clinic projection;
5. same-name clinic/doctor fixtures remain distinct and isolated;
6. ordering remains deterministic under unsorted fixture insertion;
7. serialized output contains none of the forbidden internal/private fields;
8. repeated public reads do not create sessions, appointments, queue rows, audit events, or other mutations.

## Merge gate

Exactly one canonical WU57 branch/PR: `wu57-public-doctor-availability`.

Material author: ChatGPT. Mechanical GitHub executor: ChatGPT connector. ChatGPT is recused from final gating.

Mistral Vibe is the routine first-pass exact-head reviewer whenever its included-capacity GitHub path is concretely working. Every Mistral Medium+/Major+/High+/Critical/Blocker finding is merge-blocking until reconciled. Claude is reserved for privacy/security/architecture escalation, disputed findings, or final-gate fallback when routine review evidence is unavailable or unreliable. Codex/Copilot remain eligible same-stream implementation/review failover actors subject to concrete capacity and authorship independence.

Exact-head CI must be fully green and one eligible independent non-author exact-SHA gate must clear all unresolved Medium+ findings before merge.

Zero-extra-cost only: no paid APIs, PAYG/overage/credits, Vertex, OpenRouter, auto-topups, or retired Gemini Agent/Chat.
