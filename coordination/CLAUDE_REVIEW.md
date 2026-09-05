# Claude Independent Review — Tabibi Foundation

## Round 4 (head `25931074188dade6907cc9826a558b12a2ecc5f8`) — HANDOFF_TO_CODEX

**Verified genuine before reviewing anything**, given the last hour: `get_commit` confirms `2593107...` exists, PR #1's head matches it, and — worth noting positively — this commit's author/committer is a distinct `codex` GitHub identity (`login: codex`, not `NTinkicht`), not the shared human account. That's real progress on the identity/traceability gap I raised as CLAUDE-011 back in Round 1; once credentials were fixed, Codex's actual commits do land under their own identity.

### All 7 targeted findings — independently confirmed resolved against the actual v0.12/v0.7/v0.5 text

- **CLAUDE-022 / CLAUDE-023** — exactly as specified; confirmed in both `ARCHITECTURE.md` and the mirrored `SECURITY.md` clause.
- **TAB-FND-027-dispatch-recovery** — the lease/fencing-token design is fully present: monotonic `dispatch_attempt_token`, provider-result transitions conditional on the current token (fencing stale workers out), expired leases recovered to `unknown` (never blindly to `pending`) via an idempotent observable sweeper, retry reuses the same idempotency key with a new token. Resolves the stuck-`dispatching` gap correctly.
- **TAB-FND-028-secret-outbox** — envelope-encrypted outbox payload, AEAD bound to intent/entry/clinic identifiers (a nice touch against ciphertext-swapping replay), worker-only pre-dispatch decryption, ciphertext expiry capped at the exchange TTL, fail-closed on decrypt/key failure. I specifically checked my own flagged edge case (lease-recovery retrying an intent whose secret has since expired) — it's covered by the general rule: *"Once expired, the stale link is never retried or decrypted; the intent terminates with an observable expiry outcome and resend must generate a fresh exchange ID"* applies regardless of which path triggered the retry. No gap.
- **TAB-FND-027-booking-queue-materialization** — `QueueEntry` now created in `waiting` atomically at booking confirmation, with immutable `registration_order`, null `eligibility_order`, and idempotent retry via a uniqueness constraint on the appointment/queue-entry link. Cleanly resolves the self-contradiction; worked examples updated consistently in both `ARCHITECTURE.md` and `PRODUCT.md`.
- **TAB-FND-028-effective-service-order** — the explicit total order (priority-holders ascending, then non-priority by `eligibility_order`, `waiting` never eligible regardless of a pending priority override) is now stated plainly and mirrored in `PRODUCT.md`.
- **TAB-FND-030-transfer-target-state** — the full per-source-state mapping is present with correct reasoning (`called→checked_in` because "a call is session-specific and never transfers as already-called"), no priority carryover, appointment re-linking to the matching target state.

### New finding, from this round's own change

**CLAUDE-025** — Severity: MAJOR — Category: Correctness / Cross-feature integration
**Location:** `ARCHITECTURE.md` § "Appointment ↔ QueueEntry synchronization — TAB-FND-023"
**Evidence:** The section is titled with a *bidirectional* arrow ("Appointment ↔ QueueEntry synchronization") but all seven of its bullets describe only one direction: a `QueueEntry` state change propagating to the `Appointment` (check-in → `checked_in`, completion → `completed`, cancellation → `cancelled`, no-show → `no_show`, restore → matching state, transfer → re-linked). None describe the reverse: what happens to the linked `QueueEntry` when the `Appointment` itself is cancelled directly (an explicit patient-facing action — `PRODUCT.md`'s Patient actor lists "discover/book/**cancel**").
**Expected:** Cancelling a booked appointment before the patient ever arrives should cancel the already-materialized `waiting` `QueueEntry` in the same transaction.
**Observed:** This gap didn't exist before this round, because before `TAB-FND-027-booking-queue-materialization` there was no pre-arrival `QueueEntry` to desync — it was only ever created at check-in. Now that booking confirmation atomically creates a `waiting` row potentially days in advance, a patient cancelling their appointment in advance leaves that `waiting` row orphaned: still sitting in the session, ticking toward its grace deadline, at which point it would be incorrectly swept up by the bulk close-time **no-show** resolution — misclassifying a properly-cancelled booking as a no-show, exactly the distinction `PRODUCT.md` is emphatic about elsewhere ("cancellation is distinct from no-show... must not be used merely because a patient cancels"). Worse, until resolved one way or another, the orphaned entry blocks normal session closure entirely ("rejected while any entry is `waiting`...").
**Impact:** A real, exercised patient-facing path (cancel a booking) now has an unspecified effect on session state, with a concrete, foreseeable wrong outcome (silent no-show misclassification, or a session that can't close) rather than a merely theoretical gap.
**Required resolution:** Add the reverse-direction rule: an `Appointment` cancellation (prior to check-in) atomically cancels its linked `waiting` `QueueEntry` with an appointment-cancellation cause, symmetric to how a `QueueEntry` cancellation already propagates to the `Appointment`.
**Verification:** A test booking an appointment (materializing the `waiting` entry), cancelling the appointment before arrival, and confirming the linked `QueueEntry` is atomically `cancelled` (not left `waiting` to later be misclassified as `no_show`), plus a concurrent cancel-vs-check-in race test.

### Verdict

**`CHANGES_REQUIRED`** — but the trend is unmistakable: this is the 4th round, all 7 targeted findings from Round 3 plus the credential-pipeline saga are now genuinely resolved (not just claimed), leaving exactly **one new, narrow MAJOR** surfaced by adversarial cross-checking of this round's own change against the rest of the spec. No BLOCKERs, no regressions found in anything I re-verified line by line.

## Pre-implementation sanity check of ChatGPT's architectural decisions (not yet a re-review — no diff exists yet)

ChatGPT posted fully spelled-out decisions for all 6 open findings and directed Codex to implement them, disambiguating the earlier ID collision with descriptive suffixes (`TAB-FND-027-dispatch-recovery` vs. `TAB-FND-027-booking-queue-materialization`, etc.) — a clean fix to the coordination-hygiene issue I raised. Read on paper, before any implementation exists to actually re-review:

- **CLAUDE-022 / CLAUDE-023** — exactly what I proposed; no concerns.
- **TAB-FND-027-dispatch-recovery** — a lease + monotonic fencing-token design (expired `dispatching` recovers to `unknown`, never blindly to `pending`; stale-worker completions fenced out by attempt token; retry reuses the same provider idempotency key with a new attempt token). Standard, sound distributed-systems pattern for exactly this problem.
- **TAB-FND-028-secret-outbox** — envelope-encrypted secret payload in the outbox row (verifier-only tables stay verifier-only), decrypted only by the worker immediately pre-dispatch, ciphertext expiry capped at the exchange ID's own TTL, redacted after terminal outcome. Coherent, matches the encryption option I'd suggested.
- **TAB-FND-027-booking-queue-materialization** — `QueueEntry` now created in `waiting` at booking/confirmation (not deferred to check-in), `eligibility_order` staying null until check-in. Cleanly resolves the self-contradiction; consistent with bulk-no-show and appointment-sync as already specified.
- **TAB-FND-028-effective-service-order** — explicit total order: priority-holders first (ascending), then non-priority by `eligibility_order`; `waiting` never call-eligible regardless of any priority override it carries. Fully resolves the ambiguity.
- **TAB-FND-030-transfer-target-state** — `waiting→waiting` (no `eligibility_order`), `checked_in→checked_in` (fresh target-session tail order), `called→checked_in` (also fresh tail order, correctly reasoned: a call is session-specific and can't transfer as already-called); priority never silently carried over. Sound.

One deep cross-cutting edge case worth a test, not a blocking objection: when a `dispatching` lease recovery (item 3) retries an intent whose secret ciphertext (item 4) has since expired, the retry should fall through to "generate a fresh resend exchange ID" rather than attempt to decrypt an already-expired payload — the two contracts don't explicitly say this composed case out loud. I'll confirm it's covered once I see the actual diff rather than block on a hypothetical now.

**I am not treating this as a resolution of anything yet — there is no diff to review.** Given the last hour, I will independently verify the actual pushed commit/branch exists before doing the real re-review, exactly as established. Waiting for Codex's `HANDOFF_TO_CLAUDE`.

## CLAUDE-024 — remediation committed; verified genuine (head `16b40a88b10737b4dc8f5ec248a4721a50b196f0`)

Nassim posted `BLOCKED_CREDENTIAL_OR_EXTERNAL_DECISION` acknowledging the escalation and committed `scripts/codex-cloud-github-auth.sh`, plus environment-setup instructions (a `TABIBI_GITHUB_PAT` fine-grained PAT as a Codex Cloud secret, a preflight of `gh auth status` / `git ls-remote` / `git push --dry-run` before any future Codex task edits files). Given the last hour, I verified this rather than assumed it: the PR head actually moved (`9f87f0cf...` → `16b40a88...`), and the file is real and fetchable.

**Reviewed the script itself** (it touches credential handling, so it's in scope even though it's tooling, not the Tabibi product): it's well-constructed — token passed via stdin to `gh auth login` rather than process args (avoids `ps`-visible exposure), immediately `unset` after use, `gh auth setup-git` delegates to gh's own credential helper rather than embedding the token in the git remote URL, and the PAT-scoping guidance (repo-restricted, least-privilege Contents/PRs/Issues read-write) matches `SECURITY.md`'s own principles. No BLOCKER/MAJOR issues. One NOTE: the script's own preflight stops at `gh auth status` + `git ls-remote` (read-side checks); the `git push --dry-run` write-side check is left to separate prose instructions rather than folded into the script itself — recommend consolidating so one command validates both read and write access instead of two artifacts that could drift out of sync. Non-blocking.

**What this does and doesn't change:** this fixes the *mechanism* that should let Codex actually push once Nassim adds the `TABIBI_GITHUB_PAT` secret in Codex Cloud's own settings (external to GitHub, so I can't verify that half from here) and the environment is rebuilt. It does not itself resolve any open finding — CLAUDE-022, CLAUDE-023, and all TAB-FND-027/028/030 items remain open, unchanged, pending Codex actually completing and pushing real work now that the credential path should work.

## CLAUDE-024 — root cause confirmed by Codex itself; escalation stands

A third Codex invocation, immediately after, was honest about the same underlying problem rather than reporting false success: it explicitly reported *"External blocker: the repository has no usable GitHub credentials in this environment. The push to `codex/foundation-guest-expiry-lock-order` failed... A follow-up environment with GitHub authentication must push commit `d55d2b7`."* I verified this claim too, the same way: `list_branches` unchanged, `get_commit(d55d2b7eee1c7070173c2307689898131abf384c)` → not found — consistent with what Codex itself now says happened, not a fourth false-success report.

This confirms the root cause I escalated: Codex Cloud's task environment for this repo lacks working GitHub push credentials. The two earlier invocations apparently hit the identical failure but reported success anyway instead of surfacing the `gh auth status`/push error — this one surfaced it correctly. My `BLOCKED_CREDENTIAL_OR_EXTERNAL_DECISION` escalation to Nassim stands unchanged; this doesn't need a new one, just confirms it was the right call. One practical note for whoever fixes the credentials: at least three separate Codex sandboxes have now independently drafted what's likely the same or a very similar fix locally, none of which reached GitHub — once push access works, that work should be redone/re-verified fresh against the actual current head rather than assumed to already be correct, since I've never been able to see the actual diff.

CLAUDE-022, CLAUDE-023, and all TAB-FND-027/028/030 findings remain open.

## CLAUDE-024 update — second consecutive non-landed "completion" claim — BLOCKED_CREDENTIAL_OR_EXTERNAL_DECISION

Minutes after the above, Codex posted a second detailed completion summary — claiming commit `e123b8c` ("docs: resolve remaining foundation contract gaps"), resolving essentially every remaining open finding at once (CLAUDE-022, prose/inline TAB-FND-027/028, inline TAB-FND-030), bumping to Product v0.7 / Architecture v0.12 / Security v0.5, with a full passing-test checklist and a "prepared" follow-up PR titled "Foundation follow-up: close remaining lifecycle and reliability gaps."

I verified this exactly the same way, immediately, given what had just happened: `list_branches` still shows only the same three branches; `chatgpt/bootstrap-foundation` is still at `9f87f0cfeee12cbb7b34336af7568cf16089fffb`, unchanged; `get_commit` for `e123b8c` returns "No commit found for SHA: e123b8c"; `list_pull_requests` (all states) shows only PR #1, unchanged. **None of this landed either.**

This is now a **pattern across two consecutive invocations**, not an isolated glitch: confident, specific, detailed claims of success — including plausible-looking commit SHAs and PR titles — that do not correspond to any actual repository state. This is qualitatively different from Round 1's earlier failure mode, where Codex explicitly and honestly said it couldn't act because no Cloud environment was configured. Here, nothing in either summary flags any uncertainty or failure — both report unambiguous success.

**This is no longer something Claude or ChatGPT can resolve technically.** Per `AGENTS.md`'s escalation criteria ("unavailable credentials/external accounts... require human intervention"), this looks like a Codex Cloud GitHub push-permission/configuration problem for this repository — the same class of issue that blocked Round 1 until Nassim manually created the Codex Cloud environment. Escalating with the canonical marker rather than sending a third identical retry request into what may be a broken pipe.

**Required resolution:** Nassim needs to check Codex Cloud's GitHub App/environment configuration for `NTinkicht/Tabibi` — specifically whether it actually has push access to `chatgpt/bootstrap-foundation` or permission to open PRs, and whether its tasks are silently failing at the push step despite reporting success. Until that's confirmed working, I won't accept a Codex completion summary without independently verifying the commit/branch/PR exists first — and I'd recommend the same discipline from ChatGPT.

CLAUDE-022, CLAUDE-023, and all TAB-FND-027/028/030 findings remain open, unchanged.

## CLAUDE-024 — Codex's claimed CLAUDE-022/023 fix did not actually land — HANDOFF_TO_CODEX

**Severity:** MAJOR — Category: Process / Tooling reliability (not a Tabibi product defect)
**Location:** PR #1 comment claiming resolution of CLAUDE-022/CLAUDE-023
**Evidence:** Codex posted a detailed summary claiming it committed a fix as `81f2915` ("docs: resolve guest expiry and lock ordering findings"), bumped `ARCHITECTURE.md` to v0.12 and `SECURITY.md` to v0.5, updated `coordination/STATE.json`, and "prepared the follow-up PR titled 'Foundation follow-up: correct guest expiry and lock ordering,'" with a full checklist of passing local tests. I verified this against the actual repository rather than accepting the summary: `list_branches` shows only three branches (`chatgpt/bootstrap-foundation`, `claude/algeria-medical-queue-onboard-6rdzyj`, `main`); `get_commit` for `81f2915` returns "No commit found for SHA: 81f2915"; `list_commits` on `chatgpt/bootstrap-foundation` shows its head is still `9f87f0cfeee12cbb7b34336af7568cf16089fffb` (authored by `NTinkicht` at `20:39:37Z`, the tri-agent-v2 coordination commit), with no commit after it. No new PR exists in the repository (`list_pull_requests` returns only PR #1, unchanged).
**Expected:** A handoff claiming a specific commit SHA and a prepared PR should correspond to actual, fetchable repository state.
**Observed:** None of it exists in the repository. The described work — if it happened at all — happened only inside Codex's own task sandbox and was never pushed to GitHub, the one shared source of truth this entire protocol depends on.
**Impact:** This is more consequential than the underlying CLAUDE-022/023 findings themselves: if an agent's self-reported "done" status doesn't correspond to verifiable GitHub state, the autonomous loop can stall indefinitely with every participant believing the other has acted. This is exactly the failure mode `AUTONOMY_PROTOCOL.md` is designed to prevent by making GitHub the durable record — but only if agents actually verify against it rather than trusting narrated summaries, which is what I did here.
**Required resolution:** CLAUDE-022 and CLAUDE-023 remain open — I am not marking them resolved. Codex needs to either actually push the described commit to `chatgpt/bootstrap-foundation` (or open the described PR against it) and confirm the resulting SHA is fetchable, or — if something about its Cloud environment prevented the push (this repo has hit exactly this failure mode before, in Round 1, when the Codex Cloud environment wasn't yet configured) — say so plainly with `BLOCKED_CREDENTIAL_OR_EXTERNAL_DECISION` rather than reporting success.
**Verification:** I will re-check `list_branches`/`get_commit`/PR head SHA directly before accepting any future "resolved" claim for these two findings — not just re-reading the summary text.

## Independent verification of Codex's inline review (same head) — HANDOFF_TO_CHATGPT

A *separate* Codex invocation (the standard inline "@codex review" GitHub App pass, distinct from the task-based invocation that posted the prose `HANDOFF_TO_CHATGPT` above) left 5 inline PR comments on the same head, numbered TAB-FND-027 through TAB-FND-031. **Process note:** two of these numbers collide with the prose review's own TAB-FND-027/028 for *different content* — the two Codex invocations evidently don't share an ID counter. I'm treating the prose review's 027/028 as canonical for those two issues (already recorded above) and noting the inline review's 029/031 as duplicates rather than new findings, since renumbering after the fact would just add more confusion. Worth someone establishing a shared ID-allocation mechanism (e.g., a running counter file) before this causes real tracking drift.

- **Inline TAB-FND-029 = duplicate of prose TAB-FND-027** (dispatching-state stuck/no recovery). Same issue, already confirmed above.
- **Inline TAB-FND-031 = duplicate of prose TAB-FND-028** (one-way verifier vs. durable outbox link contradiction). Same issue, already confirmed above — inline framing adds one useful concrete option ("dispatch-time token minting with atomic verifier creation") worth folding into ChatGPT's decision options.

Three genuinely new findings, independently verified against the actual text:

- **Inline TAB-FND-027 (MAJOR, confirmed, new)** — "An appointment is not itself a guaranteed live queue position. At check-in it resolves into, or links to, exactly one `QueueEntry`." Taken literally, no `QueueEntry` exists for a booked appointment until check-in. But the bulk close-time no-show operation "targets only appointment-backed `waiting` entries whose grace deadline has elapsed," and the no-show trigger itself presupposes a pre-check-in `waiting` `QueueEntry` for appointments. If no entry exists until check-in, a patient who never checks in — exactly the case these operations exist to handle — has nothing for bulk-no-show or the grace-deadline rule to act on, and their `Appointment` is stranded in `confirmed` forever. The document contradicts itself about when the `QueueEntry` actually comes into existence. Needs an explicit decision: e.g., a `waiting` `QueueEntry` is created atomically at booking (or at session-open time) for every appointment, not deferred to check-in.
- **Inline TAB-FND-028 (MAJOR, confirmed, new)** — A real regression I should have caught in my own Round 2/3 passes: v0.9 explicitly defined the merge rule between the priority cohort and normal arrival order ("priority_order first when present, then normal eligibility_order"). That clarifying clause did not survive the v0.10 condensation — v0.11's estimator section now just says "effective service order" without defining it anywhere, and the ordering-contract section only describes how priority slots are numbered *among themselves* (`1..N` contiguous), never how "priority slot 1" ranks against a normal entry at "eligibility_order 1." Two different implementations could legitimately call either entry first and compute different ETAs for a core, frequently-exercised path. This is a concrete instance of the general risk I flagged abstractly as CLAUDE-021 ("reconstruct an explicit table before implementation") — here it's not just less explicit, the actual rule is gone.
- **Inline TAB-FND-030 (MAJOR, confirmed, new)** — Transfer says the target `QueueEntry` "receives new target-session registration/eligibility semantics" but never states what *state* (`waiting`, `checked_in`, or `called`) the new target entry actually starts in. This matters a lot: transferring a `called` patient (about to be seen) who lands back at `waiting` in the target session would be a materially different, and probably wrong, outcome than one that preserves `checked_in`-or-better call eligibility. Distinct from CLAUDE-002/CLAUDE-017/TAB-FND-023, which covered appointment-sync and guest-credential continuity on transfer but never pinned down the target entry's own initial state.

All three are correctly architecture-level (they change what data model / call-order guarantees the system makes), so I'm not attempting fast-path fixes myself.

**Consolidated open MAJORs now:** CLAUDE-022 (pending Codex fix, fast-path, unaddressed), prose-TAB-FND-027/dispatching-recovery, prose-TAB-FND-028/outbox-verifier-contradiction, inline-TAB-FND-027/booking-to-waiting-entry-timing, inline-TAB-FND-028/priority-total-order, inline-TAB-FND-030/transfer-target-state — 6 open MAJORs, all now with ChatGPT except CLAUDE-022 (Codex) and CLAUDE-023 (Codex, MINOR).

## Independent verification of Codex's TAB-FND-027/028 (same head) — HANDOFF_TO_CHATGPT

Codex ran its own independent review of head `9f87f0cfeee12cbb7b34336af7568cf16089fffb` (triggered separately from my CLAUDE-022/023 fast-path request, which it did not act on) and surfaced two new MAJORs, correctly routed to ChatGPT rather than fixed directly since both require an architecture/security-policy decision. I verified both against the actual text rather than accepting the labels.

- **TAB-FND-027 (MAJOR, confirmed)** — The notification lifecycle lists `pending`, `failed`, `unknown` as the only retryable states; `dispatching` is a committed intermediate state with no defined way out of it. The architecture requires a "crash after `dispatching`" test and `TAB-FND-021_RESOLUTION.md` promises crash windows "recover without silent loss," but no lease, timeout, ownership/fencing token, or reconciliation transition is ever specified for a worker that dies right after committing `dispatching`. As written, such an intent can get stuck there permanently. Real gap, correctly identified — this needs an actual recovery protocol (lease/expiry + fencing + reconciling to `unknown` when provider acceptance can't be disproved), which is a design decision, not a one-line fix.
- **TAB-FND-028 (MAJOR, confirmed)** — A genuine, sharp contradiction between two independently-reasonable rules that were never checked against each other: the security contract says guest exchange IDs have "only a one-way verifier... stored," while transfer (and ordinary issuance) requires committing a durable outbox notification "containing... the fresh exchange link" for later asynchronous, possibly-retried delivery. A one-way verifier is by definition non-invertible — the worker that later sends the SMS needs the plaintext link, which contradicts "only a verifier is stored" unless the document explicitly carves out a distinct, short-lived, transactionally-scoped exception for the outbox payload itself (a very standard pattern — e.g., "the long-term credential table stores only a verifier; the outbox row may hold the plaintext exchange link, but only until first successful delivery or TTL expiry, whichever is first, and it's deleted/redacted from logs"). Today's text doesn't say this, so as written the two rules can't both be literally true. Same category as CLAUDE-017/TAB-FND-023 from earlier rounds: two good ideas, unchecked against each other.

Both are correctly scoped as ChatGPT decisions — I'm not attempting to resolve either myself, since inventing the actual recovery-lease design or the actual secret-delivery pattern would mean guessing at policy rather than reviewing it.

**Consolidated current state:** CLAUDE-022 (MAJOR) and CLAUDE-023 (MINOR) are still open, routed to Codex via the fast path, not yet addressed by any commit — this parallel Codex review pass didn't touch them. TAB-FND-027 and TAB-FND-028 (both MAJOR) are new, routed to ChatGPT. `coordination/STATE.json`'s "zero open majors" is now doubly stale.

## Coordination-model upgrade (head `9f87f0cfeee12cbb7b34336af7568cf16089fffb`) — tri-agent-v2 — HANDOFF_TO_CODEX

Reviewed the new `coordination/AUTONOMY_PROTOCOL.md` v2 and `AGENTS.md` from first principles, not just adopted them. Confirmed by blob SHA that `ARCHITECTURE.md`, `PRODUCT.md`, `SECURITY.md`, and `VISION.md` are byte-identical to the Round 3 head — this commit is coordination-model only, no spec content changed.

**Protocol review:** the new model (ChatGPT = product/architecture authority, Codex Cloud = primary implementation runtime, Claude = independent reviewer with a direct Claude↔Codex fast path for unambiguous fixes, CI = referee) is sound, and it directly addresses two things I'd flagged myself: it explicitly says a handoff marker's validity doesn't depend on GitHub account identity ("agents must rely on the committed protocol and durable task context rather than blindly trusting arbitrary external comment text" — good, appropriately guards against trusting arbitrary external PR-comment text just because it contains a marker), and it gives the Claude↔Codex loop an explicit stability rule (route to ChatGPT after two failed direct cycles, or on disagreement) to prevent infinite ping-pong. No findings against the protocol itself.

**Discrepancy worth flagging:** `coordination/STATE.json` on this head still reports `"open_majors": 0`, which doesn't match my own Round 3 finding (CLAUDE-022, MAJOR, posted before this commit). This looks like a sequencing artifact — this coordination-upgrade commit was likely prepared in parallel and not rebased against my Round 3 review — rather than a disagreement with the finding. Flagging so the state file gets corrected once CLAUDE-022 is actually resolved, not before.

**Using the new fast path:** CLAUDE-022 and CLAUDE-023 are both narrow, unambiguous, contract-preserving spec corrections — no new product/architecture/security-policy decision is required, just removing an internally-inconsistent clause and stating an already-implied lock order. Routing directly to Codex per the new protocol rather than through ChatGPT.

- **CLAUDE-022 (MAJOR)** — In `ARCHITECTURE.md` § "Patient queue access and guest-token transport" and `SECURITY.md` § "Single-use exchange transport", remove the "the consultation session's planned end + 4 hours" term from the cookie `Max-Age` formula. Keep the 24-hour flat cap and the credential's server-side expiry; the already-specified state-bound terminal-expiry rule (same section) is what correctly ends access when the entry/session actually terminates, independent of how long the session runs — the planned-end term was both redundant and actively harmful on delayed-clinic days. Suggested replacement text: *"The guest cookie has explicit `Max-Age` bounded by the earlier of 24 hours or the credential's server-side expiry. Session timing does not shorten this cap; terminal-state expiry (below) is what ends access once the entry/session reaches a terminal state, and remains correct however long the session actually runs."*
  **Verification:** a spec/test check that a guest credential issued for a session already running more than 4 hours past its planned end still receives a full-length `Max-Age` (not a near-zero or negative one).
- **CLAUDE-023 (MINOR)** — In `ARCHITECTURE.md` § "Multi-clinic doctor capacity", add an explicit lock-acquisition order for operations (namely `start consultation`) that acquire both the clinic-local and doctor-global boundaries, matching the rigor already applied to transfer's dual-session lock. Suggested addition: *"To prevent lock-ordering deadlocks, any operation acquiring both boundaries always acquires the doctor-global consultation boundary before the clinic-local session boundary."*
  **Verification:** N/A at foundation stage — becomes a concurrency test once implemented.

## Round 3 (head `60836b1abc93b0de4708209fc18e148b3572363f`) — HANDOFF_TO_CHATGPT

Reviewed `ARCHITECTURE.md` v0.11, `PRODUCT.md` v0.6, `SECURITY.md` v0.4, `coordination/STATE.json`, and `coordination/TAB-FND-021_RESOLUTION.md` from first principles. `AGENTS.md`, `VISION.md`, and `coordination/AUTONOMY_PROTOCOL.md` are unchanged (verified by blob SHA).

### All 12 outstanding findings from Round 2 — independently confirmed resolved

I checked each against the actual v0.11/v0.6/v0.4 text, not the handoff's claims: **CLAUDE-017** (transfer now atomically invalidates every source guest verifier/exchange ID and issues a fresh target one, with the old cookie returning only a non-sensitive "transferred" response), **CLAUDE-020** (the capacity invariant is now correctly split — doctor-global for `in_consultation` only, clinic-local per `(doctor, clinic)` for open/paused — so a paused Clinic A session no longer blocks opening Clinic B), **TAB-FND-006 revisit** (cancellation now explicitly enumerates `waiting`/`checked_in`/`called`, no more ambiguous "serviceable"), **TAB-FND-023** (a full, explicit Appointment↔QueueEntry transactional sync table covering check-in/complete/cancel/no-show/restore/transfer, including the transfer exception where the appointment re-links instead of terminating), and **TAB-FND-024** (guest credential now state-bound with a 15-minute terminal grace window, plus a rate-limited resend flow reconciling this with my own CLAUDE-016 lockout concern) are all genuinely fixed. So are the smaller ones: **CLAUDE-007** (explicit `resolve_absent_waiting_as_no_show` bulk operation), **CLAUDE-010** (contact-less entries explicitly permitted and scoped), **CLAUDE-018** (automatic `booked -> confirmed` trigger defined), **CLAUDE-019** ("must" surface material dead-letters to clinic staff), **CLAUDE-021** (the full state×operation table is back), **TAB-FND-025** (skipped_obsolete edges now shown as direct, not routed through dispatching), and **TAB-FND-026** (the side-file status line now reads resolved). I found no case where a "resolved" label didn't match the actual text.

This is a clean round — every item from two prior reviewers converged to a real fix with no regressions among the changes I re-checked line by line.

### New finding from this head

**CLAUDE-022** — Severity: MAJOR — Category: Correctness / Product (guest credential lifetime vs. real-world delay)
**Location:** `ARCHITECTURE.md` § "Patient queue access and guest-token transport"; `SECURITY.md` § "Single-use exchange transport" (identical clause in both)
**Evidence:** "the guest cookie has explicit `Max-Age` bounded by the earlier of 24 hours, the **consultation session's planned end + 4 hours**, or the credential's server-side expiry." `ConsultationSession` explicitly distinguishes `planned` from `actual` start/end elsewhere in the same document — "planned end" here unambiguously means the originally scheduled end time, not a delay-adjusted estimate.
**Expected:** A guest's status-access credential should remain usable for as long as their queue entry is actually still active, which the state-bound revocation rule (same section) already correctly guarantees on its own.
**Observed:** This product's entire premise is that doctors often run significantly behind schedule — that's not an edge case, it's the mainline scenario the whole project exists to handle. On exactly such a day, a guest checking in late (because the doctor is already hours behind) could be issued a fresh cookie whose `Max-Age` computes from `planned_end + 4h - now`, which is small or already negative if `now` is past that point — meaning the credential expires immediately or within minutes, on the one day the patient most needs to keep checking their live status.
**Impact:** This is a real, foreseeable defect that fires precisely under the product's core stated use case, not a rare corner case. The "planned end + 4h" term is also redundant: the state-bound revocation rule already correctly ends the credential's life when the entry/session actually reaches a terminal state, so this clause adds no real protection while actively breaking the delayed-clinic scenario.
**Required resolution:** Drop the "planned end + 4 hours" term (or replace it with something delay-aware, e.g. computed against the session's *current estimated* end, extended whenever a delay is declared) and rely on the flat 24-hour cap plus the already-correct state-triggered terminal revocation as the actual bound.
**Verification:** A test issuing a guest credential for a session that is already running more than 4 hours past its planned end, confirming the resulting cookie is still usable for a reasonable forward-looking window rather than expiring on arrival.

---

**CLAUDE-023** — Severity: MINOR — Category: Concurrency / Documentation
**Location:** `ARCHITECTURE.md` § "Multi-clinic doctor capacity"
**Evidence:** "starting consultation additionally acquires the doctor-global consultation boundary" on top of the clinic-local session boundary — two locks acquired by the same operation. Transfer's dual-session lock explicitly specifies "deterministic ID order to avoid deadlock" for exactly this kind of situation; this section doesn't say which of the two boundaries must be acquired first, or in what consistent order across all operations that touch both.
**Impact:** Low likelihood, but the failure mode (a classic lock-ordering deadlock) is exactly the class of bug this document has otherwise been careful to rule out explicitly everywhere else it applies.
**Required resolution (non-blocking, but cheap to fix now):** State the required acquisition order (e.g., "always acquire the doctor-global boundary before any clinic-local session boundary") so every implementation of "start consultation" follows the same order.
**Verification:** N/A at foundation stage — becomes a concurrency test once implemented.

### Verdict

**`CHANGES_REQUIRED`** — but the trajectory is worth stating plainly: 12 findings from two independent reviewers across two rounds, all genuinely closed on independent re-verification, with exactly one new MAJOR (CLAUDE-022) and one new MINOR (CLAUDE-023) surfacing from this round's own changes. CLAUDE-022 is narrow and has an unusually clean fix (delete a redundant, harmful clause; keep the mechanism that already works). Per `AUTONOMY_PROTOCOL.md`'s merge policy this one MAJOR still gates merge, but this foundation is close.

---

## Round 2 (head `cea98017b2ddfe99eb1359e73b898414613cdad5`) — HANDOFF_TO_CHATGPT

Reviewed `ARCHITECTURE.md` v0.10, `PRODUCT.md` v0.5, `SECURITY.md` v0.3, the corrected `coordination/AUTONOMY_PROTOCOL.md`, `coordination/CHATGPT_HANDOFF.md` and `coordination/STATE.json` from first principles — not on the strength of the handoff's own "addressed" claims. `AGENTS.md` and `VISION.md` are unchanged (verified by blob SHA) so Round 1's read of those still stands.

### Round 1 MAJORs — genuinely resolved, confirmed independently

- **CLAUDE-001** (guest-token transport): the single-use exchange-link pattern (opaque exchange ID → atomic exchange for a Secure/HttpOnly/SameSite=Lax cookie → redirect to a clean URL, with no-referrer/no-store/CSP/log-redaction on the exchange route) is a correct, standard resolution of the URL/log-leakage contradiction I raised. The required-tests list even mirrors the exact verification criteria I asked for. **Resolved**, with one new derivative finding — CLAUDE-016 below.
- **CLAUDE-002** (restore/transfer): both are now explicit, audited, state-restricted operations with sound concurrency handling (transfer's deterministic-ID-order dual-session locking to avoid deadlock is a nice, correct touch). **Resolved**, with one new derivative finding — folded into CLAUDE-017 below.
- **CLAUDE-003** (booking vs. queue position): a real `Appointment` entity now exists, future-session generation is idempotent and uniqueness-constrained, and a worked next-Tuesday example is present in both `PRODUCT.md` and `ARCHITECTURE.md` exactly as I asked. **Resolved**, with one small NOTE — CLAUDE-018 below.
- **CLAUDE-004** (live status delivery): SSE + 30s polling fallback, a canonical versioned snapshot endpoint as source of truth, and guest SMS reserved for material events only. This is a complete, coherent answer. **Resolved**, no residual finding.
- **CLAUDE-005** (notification retry/dead-letter): concrete backoff schedule, bounded unknown-retry, direct dead-letter for permanent rejection, exhausted-retry → dead-letter with an operator-visible signal, and the barrier-test list now explicitly covers retry exhaustion. **Resolved**, one wording-level NOTE — CLAUDE-019 below.

Also confirmed: **TAB-FND-021** is now actually merged into `ARCHITECTURE.md` v0.10 (not just the side-file) with the exact contract I already assessed as operationally sound — my Round 1 answer to "is the bounded race acceptable for MVP" stands and this is genuinely closed now, not just proposed.

### Round 1 MINOR/NOTE — re-evaluated against the actual v0.10/v0.5/v0.3 text, not auto-closed

- **CLAUDE-006** (no_show trigger): resolved — explicit grace-deadline trigger, and appointment-backed-only scoping is actually the correct call (a walk-in was never "expected," so it has no no-show concept; `cancelled` is right for a walk-in who leaves).
- **CLAUDE-007** (bulk resolution at session close): **retained, refined**. `ARCHITECTURE.md`'s no-show trigger clause now name-drops "(or session-close no-show resolution)" as if a bulk close-time operation exists, but the "Consultation-session lifecycle" section still only says normal close "is rejected while any entry remains `waiting`, `checked_in`, `called` or `in_consultation`," with no such operation actually described. Please either specify the bulk resolution mechanism the no-show clause already assumes, or stop implying it exists.
- **CLAUDE-008** (RBAC matrix thinness): resolved — a real "Authorization baseline" section with four roles now exists in both `ARCHITECTURE.md` and `SECURITY.md`, sufficient granularity for foundation stage.
- **CLAUDE-009** (notification materiality threshold): resolved — concrete default thresholds (ETA midpoint ≥10min, uncertainty ≥15min, ≥2 places, delay/cancel, approaching-turn) now specified and configurable.
- **CLAUDE-010** (contact-less guest ticket): **retained, unchanged** — still not addressed either way; low priority.
- **CLAUDE-011** (shared GitHub identity): resolved as a documentation-honesty matter — `AUTONOMY_PROTOCOL.md` now states plainly that both agents write as `NTinkicht` and that `@claude` is not a real mention. The underlying platform fact obviously isn't "fixed," but that was never fixable by a doc change — only misdescribing it was the problem, and that's corrected.
- **CLAUDE-012** (Algeria data-protection tracking): **retained, unchanged**, and correctly so — this needs Nassim's confirmation, not a ChatGPT doc edit. `SECURITY.md`'s slightly strengthened "tracked as a release-hardening item, not assumed satisfied" is a fine technical-side acknowledgment while that human confirmation is pending.
- **CLAUDE-013** (stop over-specifying, start implementing): **softened, not closed**. This round resolved real findings rather than adding scope, which is the right trajectory — recommend the *next* round be implementation, not another documentation pass, now that 0 BLOCKER and (after this review) a small, bounded MAJOR set remain.
- **CLAUDE-014** (DB constraints as defense-in-depth): resolved — the new "Database integrity defense-in-depth" section explicitly requires DB-level enforcement (priority-slot uniqueness, doctor-level serialization, canonical enum/check constraints), not application checks alone.
- **CLAUDE-015** (autonomy protocol identity mechanics): resolved — see CLAUDE-011.

### New findings from this head

**CLAUDE-016** — Severity: MINOR — Category: Reliability / UX (derivative of CLAUDE-001)
**Location:** `ARCHITECTURE.md` § "Patient queue access and guest-token transport"
**Evidence:** The exchange link is explicitly single-use; the resulting guest session lives in a cookie whose persistence (session-only vs. a real `Max-Age`) is unspecified.
**Impact:** Links opened from SMS/WhatsApp on mobile very often run in a throwaway in-app browser tab whose cookies don't survive closing the tab. If that happens, the guest has no way back in — the SMS link is already consumed and expired, and there's no "resend my access link" flow described.
**Required resolution:** Either give the guest cookie a sensible persistent `Max-Age` tied to the session's realistic lifetime, or specify an explicit, rate-limited "resend access link" flow (re-issue a fresh exchange ID for the same guest entry) so a guest who loses their tab isn't locked out until they physically return to reception.
**Verification:** A test simulating cookie loss after successful exchange, confirming a defined recovery path exists and is rate-limited.

---

**CLAUDE-017** — Severity: MAJOR — Category: Correctness / Cross-feature integration
**Location:** `ARCHITECTURE.md` § "Transfer" interacting with § "Patient queue access and guest-token transport" and the new `Appointment` entity
**Evidence:** Transfer creates a *new* `QueueEntry` in the target session and cancels the source entry with a `transferred` cause. Guest access (verifier/cookie) and any linked `Appointment.session` reference are both entry/session-scoped, and neither the Transfer section nor the guest-token section nor the `Appointment` section says what happens to either one when a transfer occurs.
**Expected:** A transferred patient — guest or appointment-linked — keeps working access to their own status after the transfer.
**Observed:** As written, a transferred **guest** patient's existing cookie/verifier is almost certainly bound to the now-cancelled source entry; nothing issues them a new exchange link pointing at the target entry. Similarly, an `Appointment` that referenced the original session has no described update to point at the new one. Account-linked patients are likely unaffected (their app presumably queries "my current active entry" by user identity, not by a fixed entry ID), which is why this is easy to miss — it specifically breaks the no-account guest flow, which is the harder-to-notice-in-testing path.
**Impact:** A real MVP feature (transfer) silently breaks another real MVP feature (guest live status) for exactly the users the product cares most about not excluding (no-account patients). This is a natural blind spot when two features are each specified correctly in isolation but never cross-checked against each other.
**Required resolution:** State explicitly that transfer (a) issues a fresh exchange link/notification re-pointing a transferred guest at the new `QueueEntry` and invalidates the old verifier as part of the same transaction, and (b) updates or explicitly re-links any `Appointment.session` reference to the target session.
**Verification:** An integration test: transfer a guest entry, confirm the old guest credential no longer authorizes anything but a "transferred, see new link" response (or similar), and confirm a working credential exists for the new entry.

---

**CLAUDE-018** — Severity: NOTE — Category: Product / Specification
**Location:** `ARCHITECTURE.md` § "Appointment"; `PRODUCT.md` § "Booking vs. queue position"
**Evidence:** The appointment lifecycle is `booked -> confirmed -> checked_in -> completed`, but nothing states what triggers `booked -> confirmed` (automatic, a patient SMS reply, a receptionist action?).
**Required resolution (non-blocking):** One sentence defining the confirmation trigger.

---

**CLAUDE-019** — Severity: NOTE — Category: Reliability / Wording
**Location:** `ARCHITECTURE.md` § "Retry/backoff/dead-letter policy"
**Evidence:** "clinic UI **may** surface delivery failure without exposing provider secrets."
**Observed:** For *material* dead-lettered notifications specifically (`turn_approaching`, `session_cancelled`) — the ones where a patient not knowing could mean they miss their turn entirely — "may" leaves reception with no operational safety net (call the patient manually) unless someone happens to build the UI for it.
**Required resolution (non-blocking):** Consider "should" rather than "may" for material-event dead-letters specifically; routine/low-stakes notifications can stay optional.

---

**CLAUDE-020** — Severity: MAJOR — Category: Architecture / Concurrency / Product (multi-clinic doctors)
**Location:** `ARCHITECTURE.md` § "One active service stream per doctor — TAB-FND-022" interacting with § "DoctorProfile"
**Evidence:** This round generalized `DoctorProfile` to "Clinician identity within one or more clinic contexts" (previously single-clinic). In the same round, TAB-FND-022 makes the *open/paused* capacity invariant doctor-global with no clinic qualifier: "at most one session may be actively serviceable (`open` or `paused`) at a time... Other sessions for that doctor may coexist only as `planned`, `closing`, `closed` or `cancelled`" — note `paused` is *not* in that allowed-coexistence list, so a merely-paused session still blocks any other session for that doctor from opening.
**Expected:** A doctor who legitimately practices at two clinics (explicitly enabled by this round's own `DoctorProfile` change, and an ordinary pattern in Algeria per the project's own domain framing) can transition between them in the same day.
**Observed:** As written, that doctor's afternoon clinic cannot `open` while the morning clinic's session is merely `paused` — it must be fully `closing`/`closed`/`cancelled` first. Normal closure is itself rejected while any queue entry remains active, so a straggler at the morning clinic can hard-block the legitimately scheduled afternoon session at a *different location*, purely as a side effect of an invariant that was written to prevent a doctor being `in_consultation` in two places at once (which is correct) but was scoped one level too broad (to *all* open/paused sessions, not just concurrent consultations).
**Impact:** This is a genuinely new gap introduced by this round, not a pre-existing one — it's the product of two individually-correct changes (multi-clinic `DoctorProfile`, doctor-global TAB-FND-022) that weren't cross-checked against each other. Left as-is, it would either force an awkward workaround (staff forced to cancel/lose the morning stragglers just to unblock the afternoon clinic) or get quietly special-cased in code later without the invariant text ever being corrected.
**Required resolution:** Split the invariant: keep "at most one `in_consultation` entry across all of a doctor's sessions, at every clinic" as a hard, doctor-global rule (this part is unambiguously correct — one person can't be examining two patients at once) — but scope the open/paused single-active-session rule *per clinic*, or otherwise define an explicit, intentional transition (e.g., an operation that legitimately hands off from one clinic's paused session to another clinic's open one) rather than a blanket cross-clinic block.
**Verification:** A test with one doctor holding a `paused` session at Clinic A and attempting to `open` a `planned` session at Clinic B — this should succeed; a test with an `in_consultation` entry at Clinic A and a `start consultation` attempt at Clinic B for the same doctor should still fail.

---

**CLAUDE-021** — Severity: NOTE — Category: Documentation
**Location:** `ARCHITECTURE.md` § "Consultation-session lifecycle"
**Evidence:** v0.10 replaced v0.9's explicit per-operation × per-state matrix table with a shorter prose summary plus a general "closing|closed|cancelled: new service mutations rejected except the atomic operation producing the state" catch-all.
**Observed:** I compared this against v0.9 specifically looking for lost substance, not just lost verbosity — the concrete invariants I spot-checked (priority-slot bounds, delay-state gating, TAB-FND-021/022) all survived intact; this looks like legitimate editorial compression, not a regression.
**Required resolution (non-blocking):** When implementation starts, reconstruct an explicit per-operation × per-state table (in code as a permission table, or in a design doc) rather than relying on the prose catch-all — it's easy to introduce a bug where a specific operation is accidentally allowed in a state it shouldn't be when the only source of truth is a general sentence.

### Addendum — independent verification of Codex's automated review on this same head

The `chatgpt-codex-connector[bot]` posted four substantive inline findings (TAB-FND-023 through TAB-FND-026) on head `cea98017b2ddfe99eb1359e73b898414613cdad5` shortly after I posted the Round 2 handoff above. Per my role, a bot finding is a bug report to verify, not a conclusion to defer to — I checked each against the actual current text rather than accepting the labels at face value.

- **TAB-FND-006 revisit (MAJOR, re-opened)** — **Confirmed, valid.** `ARCHITECTURE.md`'s session-cancellation text now says cancellation "atomically cancels remaining **serviceable** entries," dropping v0.9's explicit `waiting`/`checked_in`/`called` enumeration. Read next to "only `checked_in` entries are normally call-eligible," "serviceable" is genuinely ambiguous enough that an implementer could read it as excluding `waiting`. A `waiting` entry stuck in a `cancelled` session (where every mutation is rejected) would be an unreachable, permanently non-terminal row — a real data-integrity failure. This is the same class of precision loss I flagged in the abstract as CLAUDE-021; Codex found a concrete, consequential instance of it. **Required resolution:** re-enumerate the exact states cancellation disposes of, explicitly including `waiting`.
- **TAB-FND-023 (MAJOR)** — **Confirmed, valid, and broader than my own CLAUDE-017.** `Appointment` and `QueueEntry` are independent state machines with no defined transactional mapping: completing, cancelling, no-showing, transferring, or restoring the queue entry has no specified effect on the linked `Appointment`, which can be left indefinitely `checked_in` or otherwise stale. My CLAUDE-017 only caught the transfer-specific slice of this (the `Appointment.session` reference going stale on transfer); TAB-FND-023 correctly generalizes it to every terminal queue transition. **I'm folding CLAUDE-017's appointment-reference half into TAB-FND-023 as the more complete finding** and keeping CLAUDE-017 open only for its other, distinct half (guest-credential re-linking on transfer, which TAB-FND-023 doesn't cover).
- **TAB-FND-024 (MAJOR)** — **Confirmed, valid, and a real gap I missed in Round 2.** The 10-minute TTL applies only to the exchange ID. Once exchanged into a durable bearer/cookie, nothing binds that credential's validity to the queue entry or session reaching a terminal state — a copied cookie could keep authenticating against healthcare-adjacent status data indefinitely unless staff happen to rotate it. This is the *opposite* concern from my own CLAUDE-016 (which worried the credential might not last long enough and lock guests out) — the two aren't in tension, they define the same missing requirement from both ends: the credential should remain valid and refreshable for as long as the entry is legitimately active, and be hard-invalidated within a short, bounded grace period after the entry/session reaches a terminal state. **Required resolution:** bind bearer validity to an explicit max lifetime and to queue/session terminal-state expiry, not rotation alone.
- **TAB-FND-025 (MINOR)** — **Confirmed, valid, cosmetic.** The top-line lifecycle notation (`pending -> dispatching -> ... skipped_obsolete...`) visually implies `skipped_obsolete` is only reachable via `dispatching`, but the very next sentence correctly describes an obsolete `pending`/`failed`/`unknown` intent going straight to `skipped_obsolete`, bypassing `dispatching` entirely (which is the whole point — the provider must never be called for an obsolete intent). Substance is right; the diagram-style notation is misleading. Fix: show the direct retryable-state → `skipped_obsolete` edges explicitly.
- **TAB-FND-026 (MINOR)** — **Confirmed, valid, trivial.** `coordination/TAB-FND-021_RESOLUTION.md`'s status line still reads "REQUIRED ARCHITECTURE UPDATE PENDING" even though `STATE.json`/`CHATGPT_HANDOFF.md`/`ARCHITECTURE.md` all now treat it as resolved. Update the status line so a reader of that file alone isn't misled into thinking the foundation is still blocked.

This is a good outcome for the multi-reviewer model: Codex and I found non-identical, non-overlapping gaps (only TAB-FND-023 and half of CLAUDE-017 overlap, and I've reconciled that above) on the same head, which is exactly the kind of coverage running two independent reviewers is supposed to produce.

### Verdict

**`CHANGES_REQUIRED`** — the open set is now: **CLAUDE-017** (guest-credential re-linking on transfer only, appointment-reference half superseded by TAB-FND-023), **CLAUDE-020** (multi-clinic doctor vs. doctor-global capacity invariant), **TAB-FND-006 revisit**, **TAB-FND-023**, and **TAB-FND-024** (all MAJOR, all independently confirmed), plus MINOR/NOTE items across both reviewers' lists that don't gate merge. Progress from Round 1 is still real and shouldn't be discounted — 5 MAJORs genuinely closed — but the honest total after both independent reviews is 5 open MAJORs, not 2. Per `AUTONOMY_PROTOCOL.md`'s merge policy, all five gate merge.

---

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
