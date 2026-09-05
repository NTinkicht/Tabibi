# Claude Independent Review — Tabibi Foundation

## Round 1 re-check (head `23d7d57d16332e6b70e7c72d5d2a6587b0298be3`) — HANDOFF_TO_CHATGPT

Re-read the current PR #1 head and `coordination/AUTONOMY_PROTOCOL.md` per the autonomy kickoff instruction, before assuming any Round 1 finding changed status.

**What actually changed since Round 1's reviewed head (`a848cfa9...`):** exactly one file — `coordination/AUTONOMY_PROTOCOL.md` was added. I confirmed this by comparing blob SHAs, not just commit messages: `AGENTS.md`, `ARCHITECTURE.md`, `PRODUCT.md`, `README.md`, `SECURITY.md`, `VISION.md`, `coordination/CHATGPT_HANDOFF.md`, `coordination/STATE.json`, and `coordination/TAB-FND-021_RESOLUTION.md` all have byte-identical SHAs to what I reviewed in Round 1. `ARCHITECTURE.md` is still v0.9.

**Status of Round 1 findings CLAUDE-001 through CLAUDE-014:** all still fully open. None have been fixed, none have been technically rebutted — there is no product/architecture/security content change to evaluate yet. This is a factual statement about diff content, not a criticism of intent; the PR comments describe CLAUDE-001..005 as "accepted as the next engineering work queue," which is a reasonable starting position, but no corresponding edit exists yet.

**Pre-existing TAB-FND-021 status:** also still open by the project's own stated closure criteria in `coordination/TAB-FND-021_RESOLUTION.md` ("bump ARCHITECTURE.md v0.9 -> v0.10... record TAB-FND-021 as resolved... only after the architecture change is committed"). I already independently assessed the *proposed* contract in that side-file as operationally sound for MVP (see the Round 1 answer below) — but a sound proposal living only in `coordination/TAB-FND-021_RESOLUTION.md` is not the same as a resolved finding, and until it's merged into `ARCHITECTURE.md` itself, the canonical architecture document still contains the superseded claim that final DB revalidation alone is authoritative for provider dispatch. This isn't a new Claude finding — it's your own tracked item — but I want the record to reflect that it remains open, not resolved.

**New finding from the latest head:**

**CLAUDE-015** — Severity: MINOR — Category: Process / Coordination-architecture
**Location:** `coordination/AUTONOMY_PROTOCOL.md`
**Evidence:** The protocol describes GitHub-native mechanics between distinguishable actors — "ChatGPT... posts `HANDOFF_TO_CLAUDE` with `@claude` when available," "Claude... independently monitors GitHub... posts... `HANDOFF_TO_CHATGPT`" — without addressing CLAUDE-011 (Round 1): this session's GitHub write identity resolves to `NTinkicht`, the repository owner, the same account posting on behalf of "ChatGPT/Codex." There is no GitHub account literally named `claude` in this repository's collaborators, so `@claude` in a PR comment triggers no GitHub notification — it is a human-readable marker, not a mention.
**Expected:** A coordination protocol whose described mechanisms match what's technically true today.
**Observed:** Two of the protocol's own mechanisms don't work exactly as written: (1) GitHub review-state semantics that assume distinguishable actors (I already couldn't submit a `REQUEST_CHANGES` review on "my own" PR in Round 1); (2) "@claude" as a wakeup trigger is not GitHub-native — what actually delivers activity to me is an explicit `subscribe_pr_activity` webhook subscription on this PR (now active, see below) plus this chat session being invoked, not a GitHub mention notification.
**Impact:** Low — doesn't block any technical work — but worth correcting so nobody is surprised later that `@claude` doesn't page anyone by itself, and so the protocol's "monitoring expectations" section describes the real mechanism rather than an idealized one.
**Required resolution:** Optional edit to `AUTONOMY_PROTOCOL.md` describing the actual trigger mechanism (PR-activity subscription + session invocation) rather than implying a GitHub-native mention system exists.
**Verification:** N/A — documentation-accuracy item.

**Monitoring mechanism now active (per the protocol's own "document what's actually active" requirement):**
1. **`subscribe_pr_activity` on PR #1** — an active webhook subscription; new comments, CI status changes, and reviews on PR #1 are delivered directly into this session as wake events. This is the primary, reliable mechanism and requires no manual re-check.
2. **A recurring 6-hour heartbeat Routine** (`trig_01XozFGvVxAUUrYj3W9VdvKW`, bound to this same persistent session) as a fallback that also sweeps for new issues/PRs elsewhere in the repo that a single PR subscription wouldn't catch. Caveat, stated plainly rather than glossed over: trigger creation returned a warning that fresh sessions spawned by a Routine may run without `mcp__<server>__*` connector tools; this Routine resumes *this same session* rather than spawning a new one, so I expect existing tool access (including the GitHub MCP server) to carry over, but I have not yet observed it fire and cannot fully confirm that until it does. If a future heartbeat turns out to lack GitHub tool access, that will itself be worth recording as a finding.

Neither mechanism depends on Nassim telling me to check GitHub.

**Current verdict: unchanged — `CHANGES_REQUIRED`** (5 MAJOR: CLAUDE-001..005, all open; plus MINOR/NOTE CLAUDE-006..015).

---

## Round 1 — Foundation audit (PR #1: "Foundation: product, architecture, security and agent protocol")

**Reviewed head:** `a848cfa9cd66f754410f932ec0aad658e251fa44` on `chatgpt/bootstrap-foundation`
**Documents reviewed:** `README.md`, `VISION.md`, `PRODUCT.md` (Foundation v0.4), `AGENTS.md`, `ARCHITECTURE.md` (Foundation Proposal v0.9), `SECURITY.md` (Baseline v0.2), `coordination/STATE.json`, `coordination/CHATGPT_HANDOFF.md`, `coordination/TAB-FND-021_RESOLUTION.md`, and the full PR #1 comment history (15 comments).
**CI status at review time:** no check runs configured on this head (`get_check_runs` → 0 results). Expected at this stage since the PR contains no application code.
**No production code exists yet.** This review covers specification quality only.

## Method

This is an independent read from first principles, not a validation pass over "Codex already fixed this." The PR thread frames findings TAB-FND-001 through TAB-FND-021 as resolved by an independent Codex review cycle. I evaluated the actual document text on its own merits and did not treat prior resolution claims as pre-validated (see CLAUDE-011 below for why, and for the record, my read of the merged content: the TAB-FND-001…020 resolutions are technically sound and I have no independent objection to them — I did not find a case where a "resolved" item actually regressed or was resolved incorrectly).

## Strengths worth naming explicitly

Adversarial review should not manufacture problems where the design is actually good. Several parts of this foundation are unusually rigorous for a pre-code stage:

- The three-key ordering model (`registration_order` / `eligibility_order` / `priority_order`) correctly solves the "late arrival overtakes an already-present patient" bug class and the priority-collision/renumbering race class in the same stroke.
- `called` being counted as committed work-ahead until it resolves, with active-consultation remaining time replacing rather than stacking on top of it, is the correct fix for a very common ETA double-counting bug.
- The provisional (unarrived) vs. live (checked-in) estimate split, with an explicit atomic switch at check-in, is the right way to avoid promising a fabricated exact position to someone who hasn't arrived.
- Guest-token design (raw token issued once, only a one-way verifier persisted, display label kept separate from the access credential) is correct baseline security engineering for anonymous/no-account patients.
- The TAB-FND-021 provider-dispatch contract is honest: it explicitly documents a bounded race at the network boundary instead of promising atomicity a database transaction cannot deliver across an HTTP call. That is the right call for MVP (see my direct answer to the question raised in that thread, below).

## Findings

---

**CLAUDE-001** — Severity: **MAJOR** — Category: Security
**Location:** `ARCHITECTURE.md` § "Patient queue access" (guest-token contract); `SECURITY.md` § "Secrets" / "Logging"
**Evidence:** `ARCHITECTURE.md` requires the raw bearer token be "returned only at issuance/rotation" and never persisted, while `SECURITY.md` requires guest tokens "never... expose in analytics, or place in publicly shared URLs" and operational logs "must never contain raw tokens." Neither document says *how* the token actually reaches a guest patient who has no account and possibly no smartphone app.
**Expected:** A transport mechanism for the guest credential that is consistent with the no-URL/no-log constraints already written into the spec.
**Observed:** The only realistic MVP delivery channel described anywhere in the product docs is SMS (VISION.md / PRODUCT.md notification channels). The natural, cheapest implementation of "SMS a guest their queue status" is a clickable link containing the token (`tabibi.dz/q/<token>`). That directly contradicts the "never in a publicly shared URL" rule: a URL-embedded bearer token ends up in browser history, is trivially forwardable by the patient, and — unless the team also decides to *not* log full request paths — lands in ordinary web-server/reverse-proxy/CDN access logs and `Referer` headers of any third-party resource the landing page loads, which contradicts "operational logs must never contain raw tokens" without anyone having written a line of code that looks wrong.
**Impact:** Whoever implements the guest flow will pick the URL-link pattern by default (it's the simplest thing that works) and unknowingly violate the security baseline the same PR claims to satisfy — the kind of gap that surfaces during a pilot, not during code review, because nothing in the spec flags it as a decision point.
**Required resolution:** Make an explicit architectural decision on guest-token transport before implementation, e.g.: (a) single-use, short-TTL opaque link ID in the URL that the server immediately exchanges for a session cookie and invalidates on first use, with the *actual* long-lived verifier never appearing in any URL; or (b) phone number + short numeric code entered manually (no URL at all), with the code treated as a low-entropy secret requiring aggressive rate-limiting/lockout rather than as the high-entropy bearer token described today; or (c) accept the URL-token pattern explicitly, with compensating controls documented (e.g. `Referrer-Policy: no-referrer`, access-log path redaction/hashing for this route, link single-use + short TTL).
**Verification:** A test proving the chosen transport, once implemented, cannot be recovered from standard server/CDN access logs, `Referer` headers, or browser history in a way that grants queue access after intended expiry.

---

**CLAUDE-002** — Severity: **MAJOR** — Category: Architecture / Specification compliance
**Location:** `VISION.md` § "Clinic/reception experience" vs. `ARCHITECTURE.md` § "Queue state machine — proposed"
**Evidence:** `VISION.md` explicitly promises reception can "Check-in, mark absent, defer, **restore**, cancel, **transfer** and priority handling according to policy." `ARCHITECTURE.md`'s state machine is `waiting -> checked_in -> called -> in_consultation -> completed` plus `-> cancelled` / `-> no_show` terminal branches — there is no transition that restores a terminal/mis-stated entry, and no operation moves a `QueueEntry` between sessions/doctors (transfer). The state machine section even acknowledges the gap in the abstract ("Rollback/recovery transitions must be explicit administrative actions and audited") without ever defining one.
**Expected:** Either the state machine defines `restore` and `transfer`, or `VISION.md` is corrected to not promise operations the architecture doesn't support (even as a stated future-work item, so nobody discovers the mismatch mid-implementation).
**Observed:** A real cross-document inconsistency: one document promises capabilities the other's formal model has no path for.
**Impact:** "Restore" in particular is not a nice-to-have — reception staff *will* mis-click (check in the wrong patient, call the wrong entry) under normal daily pressure, and today's only prescribed remedy is cancel-and-recreate, which mangles `registration_order`/audit history and can unfairly cost a patient their place. This is exactly the kind of gap that's cheap to specify now and expensive to retrofit once the state machine and its invariants are implemented and tested.
**Required resolution:** Decide, for the MVP, whether "restore" is (a) in scope as a real state-machine transition with its own authorization/audit rule, or (b) explicitly out of scope with cancel-and-recreate as the accepted MVP workaround — and make `VISION.md` and `ARCHITECTURE.md` agree either way. Same decision needed for "transfer."
**Verification:** `VISION.md` and `ARCHITECTURE.md` no longer disagree on the operation set; if restore/transfer are in scope, the state-operation matrix and required-tests list are extended to cover them the same way every other transition is.

---

**CLAUDE-003** — Severity: **MAJOR** — Category: Architecture / Data model
**Location:** `ARCHITECTURE.md` § "Core entities"; `PRODUCT.md` § "Product proposition" item 1
**Evidence:** The product proposition's first item is "doctor discovery and **appointment booking**," and `PRODUCT.md`'s notification events include `appointment_confirmed`. But no entity in `ARCHITECTURE.md` represents a booked appointment or time slot — `ConsultationSession` is "a bounded queue/service period for one doctor at one clinic," and `QueueEntry` carries only an "immutable registration/booking-order reference," not a time. There is also no description of how a `ConsultationSession` for a *future* calendar day comes into existence (who/what creates tomorrow's session — a cron job, a manual receptionist action, an implicit first-registration trigger?).
**Expected:** A clear answer to: does "booking an appointment" mean reserving a real time slot, or does it mean reserving a queue position on a future date with no time guarantee (i.e., the whole system is queue-based, and "appointment" is just a projected position)? And a defined mechanism for how sessions for future dates get created given the heavy lifecycle invariants (`planned -> open -> ...`) already attached to `ConsultationSession`.
**Observed:** Both are currently undefined. This is not a nitpick — it changes the schema (does a booking need its own entity distinct from `QueueEntry`, with its own lifecycle, before a session even exists to hold it?), the estimator (a time-slot promise implies a very different UX contract than a position-only promise), and the recurring-session-creation job that nothing currently describes.
**Impact:** This is precisely the class of gap the review brief calls out — "MVP omissions that would cause costly rework." Retrofitting a time-slot concept, or a pre-session booking entity, after `QueueEntry`/`ConsultationSession` and their invariants are implemented and tested would touch nearly everything already specified.
**Required resolution:** Add an explicit "Booking vs. queue position" decision to `PRODUCT.md`, and either (a) define a lightweight pre-session `Booking`/`Appointment` entity that later resolves into a `QueueEntry` once its session exists, plus the job/trigger that creates future sessions, or (b) explicitly state for MVP that "booking" only ever means "reserve a place for a specific already-existing/already-scheduled session," with no support for booking a date that doesn't have a session yet.
**Verification:** A worked example in `PRODUCT.md`/`ARCHITECTURE.md` tracing "patient books Dr. X for next Tuesday" end-to-end through entity creation, without hand-waving the session-doesn't-exist-yet problem.

---

**CLAUDE-004** — Severity: **MAJOR** — Category: Architecture
**Location:** `ARCHITECTURE.md` § "Open questions for architecture review", item 1
**Evidence:** Open question 1 asks "Is Next.js modular-monolith architecture sufficient for an MVP with real-time queue updates, or should we separate the API/runtime earlier?" — real-time delivery is named, but only as a framing detail inside a stack-sufficiency question, not as its own decision.
**Expected:** Given "You are currently #7, estimated 14:25" *updating live* is the product's headline differentiator, the actual delivery mechanism for the patient-facing live view — polling interval, Server-Sent Events, WebSocket, or "only via push notification, no live in-page view" — should be an explicit, named decision with its own trade-offs (cost/battery/data usage for the low-bandwidth, no-app, guest-by-SMS-link users the product explicitly targets), not an implicit sub-detail of a stack question.
**Observed:** No mechanism decision, no API shape for "get my current status," and no discussion of the specific constraint that guest patients (per `VISION.md`, potentially no smartphone/app) most plausibly get updates via SMS push only, which is a materially different architecture than "the web page updates live."
**Impact:** This decision affects the API surface (`ConsultationSession`/`QueueEntry` read endpoints), infra choice (does the chosen host support long-lived connections at all), and cost model (SMS-per-update is not the same cost shape as a websocket). It is cheap to decide now and expensive to discover mid-build.
**Required resolution:** Add an explicit decision (even a provisional MVP one, e.g. "authenticated web clients poll every N seconds; guest/no-account patients receive SMS only, no live page") to `ARCHITECTURE.md`, separated from the general Next.js-sufficiency question.
**Verification:** The decision is testable — e.g. a documented polling interval/endpoint contract, or an SSE/WebSocket endpoint spec, that a future PR can be checked against.

---

**CLAUDE-005** — Severity: **MAJOR** — Category: Reliability / Notifications
**Location:** `coordination/TAB-FND-021_RESOLUTION.md`; `ARCHITECTURE.md` § "Notifications"
**Evidence:** The provider-dispatch lifecycle is defined as `pending -> dispatching -> delivered|failed|unknown` plus `skipped_obsolete`. Nowhere is there a retry/backoff policy for `failed`, nor a cap/reconciliation path for an intent that repeatedly comes back `unknown`.
**Expected:** Since `failed` and `unknown` are named lifecycle states, the spec should say what happens *after* reaching them — otherwise they are dead ends in the state machine.
**Observed:** No retry count, backoff, or dead-letter/operator-visibility path is defined. As written, a transient SMS-provider error could produce `failed` with no further action ever taken, silently dropping a patient-facing notification (including safety/operationally relevant ones like "your turn is approaching").
**Impact:** This directly undermines the product's core notification promise, and it's the kind of gap that only shows up in production once a provider has a bad afternoon — not in any test written against the current spec, because the current spec doesn't ask for one.
**Required resolution:** Define a bounded retry/backoff policy for `failed`, a cap on `unknown`-retry attempts before the intent is treated as terminally undelivered, and some operator-visible signal (log/alert/queue) for intents that exhaust retries — this doesn't need to be sophisticated for MVP, but it needs to exist.
**Verification:** A test proving a `failed` intent is retried according to the documented policy and, after exhausting it, produces a distinguishable terminal outcome rather than silently disappearing.

---

**CLAUDE-006** — Severity: MINOR — Category: Correctness / Specification
**Location:** `ARCHITECTURE.md` § "Queue state machine — proposed"; `PRODUCT.md` § "Queue semantics"
**Evidence:** The state diagram lists `waiting -> no_show` as an allowed terminal path. `PRODUCT.md` clarifies no-show "must not be used merely because a patient cancels after being called," implying no-show is primarily about failing to respond to a call — but that leaves the `waiting -> no_show` transition (a patient who never even checked in) with no stated trigger condition distinguishing it from `waiting -> cancelled`.
**Expected:** A stated rule for what actually causes a never-arrived `waiting` entry to become `no_show` rather than `cancelled` (e.g., "auto no-show at session close for any appointment-booked entry still `waiting`," vs. staff-initiated cancellation at any time).
**Observed:** No rule stated; both transitions exist with overlapping apparent applicability.
**Impact:** This is a real ambiguity for anyone implementing the transition guard, and it quietly affects any future no-show-rate statistic, but it doesn't threaten data integrity or security on its own.
**Required resolution:** One sentence in `PRODUCT.md` defining the trigger condition for `waiting -> no_show`.
**Verification:** State-transition unit tests can assert the specific condition rather than treating the transition as staff-discretionary.

---

**CLAUDE-007** — Severity: NOTE (recommended enhancement, not a blocker) — Category: UX / Product
**Location:** `ARCHITECTURE.md` § "Normal closure"
**Evidence:** "A normal `close` operation is rejected while any queue entry remains in `waiting`, `checked_in`, `called`, or `in_consultation`... staff must first resolve remaining entries explicitly."
**Observed:** Every straggling booked-but-never-arrived entry must be resolved one at a time before a session can close. On a busy day with several no-shows this is friction directly against the stated "operational simplicity" and "reception-first usability" principles.
**Required resolution (optional, non-blocking):** Consider a bulk "resolve all remaining `waiting` entries as no-show" action as part of the close flow, rather than requiring staff to touch each one individually. Flagging now so it's a deliberate choice rather than a discovered annoyance after launch.

---

**CLAUDE-008** — Severity: MINOR — Category: Security / Architecture
**Location:** `ARCHITECTURE.md` § "Core entities" (`ClinicMembership`); `SECURITY.md` § "Threats to explicitly test/review"
**Evidence:** `SECURITY.md` names "cross-clinic authorization bypass" and "privilege escalation receptionist -> platform/other clinic" as explicit threats to test, but `ClinicMembership` is described only as "Maps users to clinic-scoped roles and permissions" — no role enumeration or permission matrix exists yet (roles are named informally in `VISION.md`: doctor, receptionist, clinic manager, platform administrator).
**Impact:** There is currently nothing concrete for an authorization test to assert against beyond "some roles exist." Not urgent for a docs-only PR, but should land before the first PR that implements auth.
**Required resolution:** A minimal role/permission table (which role can do which of the operations in the session-state matrix) before authentication/authorization implementation starts.
**Verification:** SECURITY.md's named cross-clinic threats become literal test names once the role table exists.

---

**CLAUDE-009** — Severity: MINOR — Category: Product / Reliability
**Location:** `PRODUCT.md` § "Notification-domain events"
**Evidence:** `estimate_changed_materially` is a named event, but no document defines what "materially" means (absolute minutes? percentage of remaining wait?).
**Impact:** Left undefined, the path of least resistance for an implementer is to notify on every recomputation, which risks exactly the "excessive messaging" the product is supposed to avoid — and, concretely, costs real SMS money per message in a channel Algeria users will likely rely on heavily.
**Required resolution:** A placeholder default threshold (e.g. "ETA change ≥ 10 minutes or ≥ 20% of remaining estimated wait, whichever is smaller") documented as configurable, so a real number exists before someone has to guess one under deadline pressure.
**Verification:** A test asserting notifications are suppressed below threshold and sent at/above it.

---

**CLAUDE-010** — Severity: NOTE — Category: Product
**Location:** `VISION.md` ("anonymous temporary ticket"); `PRODUCT.md` (queue entry fields)
**Evidence:** `VISION.md` mentions an "anonymous temporary ticket" as a reception fast-entry option; `PRODUCT.md` never states whether a contact channel (phone number) is mandatory to create a queue entry.
**Impact:** A contact-less entry cannot receive any delay/approach/turn notification — which is fine as an accepted degraded case (it's still strictly better than the paper-list status quo, since the patient at least has a position), but it should be a stated, deliberate product decision rather than an implicit consequence nobody decided on purpose.
**Required resolution (optional, non-blocking):** One sentence in `PRODUCT.md` stating whether contact info is required at entry creation, and if not, that notification-dependent features are explicitly unavailable for that entry.

---

**CLAUDE-011** — Severity: NOTE — Category: Process / Traceability
**Location:** PR #1 comment history; commit authorship; this session's own GitHub identity
**Evidence:** All 37 commits on `chatgpt/bootstrap-foundation` and every "Codex Round A–I" resolution comment (TAB-FND-001 through TAB-FND-021) are authored by the repository owner's GitHub account (`NTinkicht`). The only distinguishable automated identity present on this PR, `chatgpt-codex-connector[bot]`, has posted exactly twice, both times only the boilerplate "create an environment for this repo" message — it has never posted a review, a finding, or a commit on this PR. This is confirmed, not just suspected: while posting this very review, GitHub rejected my attempt to submit it as a `REQUEST_CHANGES` review with the error *"Can not request changes on your own pull request"* — and a `get_me` call in this session resolves to `NTinkicht` (the PR's author), not a distinct Claude identity. I had to fall back to a plain `COMMENT`-event review for that reason.
**Observed:** This session's own GitHub write access is the same account as the PR author and (going by the identical pattern) the same account that posted every "Codex" resolution comment. From GitHub's record alone, there is currently no technical way to distinguish "Nassim," "ChatGPT/Codex," and "Claude" as separate actors — all three currently write to this repository through one human account's credentials.
**Impact:** This doesn't mean the reviewed content is wrong — I evaluated it independently on its technical merits above rather than deferring to the "Codex already reviewed this" framing, which is what my role requires regardless of provenance. But the stated long-term goal of this project is to measure whether ChatGPT + Claude + deterministic CI + GitHub can meaningfully reduce human micromanagement; that measurement, and GitHub-native mechanics like requested-reviewer state, review-approval gating, and per-agent audit trails, structurally depend on each agent having its own identity. Right now none of that is possible — GitHub itself just told me so.
**Required resolution:** None required to accept this PR's technical content. Recommend provisioning distinct GitHub identities (a Claude Code/App identity separate from `NTinkicht`, and confirming Codex's commits/comments land under `chatgpt-codex-connector[bot]` or similar once its environment is functioning) before leaning further on GitHub review mechanics (approvals, requested changes, branch protection) as the coordination substrate — otherwise those mechanics will keep silently no-op'ing or falling back the way my review event just did.

---

**CLAUDE-012** — Severity: NOTE — Category: Legal / Regulatory (human escalation recommended, not a technical blocker)
**Location:** `SECURITY.md` § "Regulatory note"
**Evidence:** `SECURITY.md` correctly declines to invent compliance claims and defers regulatory research to before production.
**Observed:** I'm not overriding that deferral or asserting a legal conclusion — I'm not qualified to and the doc is right not to guess. But I can name the specific mechanism worth tracking concretely rather than leaving it as a generic placeholder: Algeria's Law 18-07 on the protection of individuals in the processing of personal data, and its supervisory authority (ANPDP), generally treat health-related personal data as a sensitive category that can require prior authorization before processing. (I have not independently verified the current text/enforcement posture of this law against production use here — this needs real legal research, not my recollection.)
**Required resolution:** No action needed for this PR. Recommend Nassim confirm this specific law/authority is on the pre-launch legal research list (per `AGENTS.md`'s own criterion: "legal, privacy or regulatory interpretation requires human judgment"), so it doesn't get lost as a vague "check regulations later" item.

---

**CLAUDE-013** — Severity: NOTE — Category: Process / Architecture
**Location:** Whole-PR observation
**Evidence:** 21 rounds of specification-only findings (TAB-FND-001…021) have been resolved across ~30KB of `ARCHITECTURE.md` alone, with zero lines of application code and zero automated tests written against real PostgreSQL.
**Observed:** Several of the hardest claims in this spec — the one-`in_consultation`-per-session invariant, priority-cohort renumbering under concurrent mutation, the session-serialization boundary itself — are concurrency claims that cannot actually be verified by more prose. Prisma's fit for the exact locking strategy needed is explicitly flagged as conditional in `ARCHITECTURE.md` ("provided transaction/concurrency requirements are demonstrably met") and has not yet been demonstrated.
**Impact:** The marginal value of further pre-code specification is now lower than the risk of an untested assumption compounding across more rounds of prose.
**Required resolution:** None required to accept this PR. Recommend the next PR be a minimal vertical-slice implementation — core queue lifecycle plus the one-active-consultation invariant and priority renumbering, tested against a real PostgreSQL instance in CI — rather than a further documentation-only round, so any wrong assumption surfaces empirically while it's still cheap to fix.

---

**CLAUDE-014** — Severity: MINOR — Category: Architecture / Data integrity
**Location:** `ARCHITECTURE.md` § "Queue consistency"; § priority-order rules
**Evidence:** The at-most-one-`in_consultation`-per-session invariant and the priority-order uniqueness invariant are both currently specified as enforced entirely by the application acquiring "the session mutation boundary" correctly in every code path.
**Impact:** That's necessary but not sufficient as the only safeguard — any future code path that forgets to acquire the lock (an admin script, a data backfill, a bug introduced during refactor) can silently violate the invariant with no guardrail beneath the application layer.
**Required resolution:** Recommend both invariants also be backed by a database-level constraint as defense-in-depth: a partial unique index on `(session_id, priority_order) WHERE priority_order IS NOT NULL`, and a partial unique index (or exclusion constraint) enforcing at most one `in_consultation` row per session. This is additive to, not a replacement for, the transactional/serialization design already specified.
**Verification:** A test that attempts to violate either invariant via a raw SQL statement that bypasses the application's serialization boundary, and confirms the database itself rejects it.

---

## Direct answer to the question raised in the Round I comment

*"whether the narrowed guarantee is operationally safe and whether any stronger provider-specific ordering mechanism is truly required for MVP"* — Yes, the narrowed bounded-race guarantee in `TAB-FND-021_RESOLUTION.md` is operationally safe for MVP, and no stronger cross-version ordering mechanism should be built now. Attempting to guarantee absolute ordering across an external provider call would require either blocking all subsequent mutations on provider acknowledgment (unacceptable latency for a live queue) or provider-side sequencing support most SMS/WhatsApp/push providers don't generically offer — disproportionate complexity for the actual failure window involved. The two things I'd still add are CLAUDE-005 (retry/dead-letter policy — a real gap, not a refinement) and, optionally and non-blocking, embedding a monotonic version or generated-at timestamp in the outbound message body so a rare stale message that does slip through the documented race is at least self-describing to the patient rather than silently confusing.

## Testing strategy assessment (requested scope: "minimum testing strategy needed before implementation")

- **Unit tests** (no DB): pure state-transition guards and the estimator, driven directly off the session-state operation matrix. Recommend generating these tests programmatically from the matrix itself (one row/column pair → one test case) so the matrix and its test coverage cannot silently drift apart as the matrix evolves.
- **Integration tests against real PostgreSQL are not optional** for this design — nearly every hard invariant here (one active consultation, priority renumbering, session-boundary serialization, guest-verifier auth) is a database-concurrency or database-constraint claim that cannot be verified any other way. CI must run these against a real Postgres service from the *first* implementation PR, not a mocked/in-memory substitute and not deferred to "later."
- **Authorization tests**: `SECURITY.md`'s own "Threats to explicitly test/review" list is already a nearly complete negative-test checklist (cross-clinic bypass, verifier-vs-raw-token, display-label-cannot-authorize, revoked-token replay, etc.) — recommend those threat descriptions become literal test names/IDs so coverage of that list is traceable.
- **E2E tests**: defer until real UI exists; not meaningful to specify further at foundation stage.

## PROPOSED SPECIALIST SKILLS

Per the onboarding instructions, I'm proposing — not yet creating — a small set of project-specific reviewer specialists, to be created once implementation actually begins in each domain (there is no code yet to specialize around, and creating them now would be speculative). Each is scoped to avoid overlap with the general reviewer role I'm using for this Round 1 audit.

1. **Queue-State & Concurrency Auditor** — Owns verifying any PR touching `ConsultationSession`/`QueueEntry` lifecycle against the state-operation matrix and the registration/eligibility/priority ordering contract; inspects PostgreSQL concurrency test coverage for the invariants in `ARCHITECTURE.md`. *Invoke when:* a PR touches queue/session/priority/estimator schema or logic. Not needed until the first such PR exists.

2. **Healthcare Privacy & Guest-Access Reviewer** — Owns guest-token issuance/transport/verifier design, patient-identity minimization, cross-clinic isolation, and log/URL/analytics leakage review (the exact class of issue in CLAUDE-001). *Invoke when:* a PR touches authentication, guest access, logging, or any patient-identifying data path.

3. **Notification/Outbox Reliability Reviewer** — Owns the delivery-lifecycle state machine, supersession/versioning correctness, retry/backoff/dead-letter policy, and idempotency-key correctness for `NotificationIntent`/outbox/provider-adapter code. *Invoke when:* a PR touches notification generation or delivery.

4. **Spec-vs-Implementation Compliance Checker** — Lightweight, run on every PR: diffs the actual code/schema against `PRODUCT.md`/`ARCHITECTURE.md`/`SECURITY.md` to catch drift of the kind found in CLAUDE-002 (VISION promising operations the state machine doesn't define), and keeps `coordination/STATE.json`/`CHATGPT_HANDOFF.md` claims honest against the real diff rather than the narrated one.

Deliberately not proposing a frontend/RTL/localization specialist yet — there is no UI code to review, and creating that specialist now would be pure speculation; it should be proposed once the first UI PR lands.

## Verdict

**CHANGES_REQUIRED**

Rationale per severity discipline: five MAJOR findings (CLAUDE-001 through CLAUDE-005) each represent a concrete gap likely to cause either a real security exposure (CLAUDE-001) or costly rework (CLAUDE-002, CLAUDE-003, CLAUDE-004) or a silent reliability failure of the product's core promise (CLAUDE-005) if implementation starts before they're addressed. None require re-architecting what's already there — each has a bounded, stated resolution path. No BLOCKER-severity findings: nothing here reflects unsafe-to-merge content for a documentation-only PR, and the overall design quality (see Strengths) is genuinely strong. Per `AGENTS.md`'s resolution protocol, I expect ChatGPT to either resolve or technically rebut each MAJOR with evidence; MINOR/NOTE items are recorded for tracking and do not block acceptance.
