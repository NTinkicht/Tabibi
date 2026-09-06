# Claude Independent Review — Tabibi Foundation

# PR #39 re-review — CLAUDE-031's production fix verified correct; the fix's own new test has a trivial bug

Codex pushed the fix fast (same round-trip pattern as the earlier bigint-cast CI failure). Their CHECKPOINT was honest about a real limitation: GitHub CI had not actually run for the new exact head (`73fdb493...`) yet — a close/reopen meant to trigger it apparently didn't enqueue a run under their runtime's constraints. Good instinct on their part to say so explicitly rather than claim CI evidence that didn't exist. That meant my own local verification was the *only* real evidence available, which is exactly the situation this role exists for — didn't wait around for CI to eventually catch up.

Worktree + real Postgres again. The production fix is exactly what I proposed in the finding: a single bulk `UPDATE ... SET service_order=NULL WHERE id=ANY($1::uuid[])` for the whole locked cohort before assigning final `1..length` values, which structurally removes every touched row from the partial unique index before any new value goes in — not a smarter offset calculation, a real elimination of the assumption. Re-ran my own original repro test against this exact head: it now passes cleanly, checked-in `service_order` ends up `[1,2,3]` as expected. Ran the rest of the suite too (lifecycle, clinic-scheduling, walk-in, database, unit+API, typecheck, lint) — all green, no regressions introduced by the fix.

Then found something CI would have caught if it had run: their own new regression test (the one specifically written to cover this gap scenario) calls the `no_show` command without the required `reason` field, so it throws a validation error before ever reaching the part of the test that exercises the fix. Small, mechanical bug — one line — but worth catching now rather than letting it surface as a red CI run after the fact, especially since I already know from my own manual run of the equivalent scenario that the test's assertions are correct once that line is added.

Also noted (not blocking, not mine to fix): `mergeable_state` is `dirty` — base has moved since the branch was cut. Flagged it so it isn't missed, without touching it myself; that's implementation-lease territory, not review territory.

Net effect: a much smaller ask than the original MAJOR — one line in a test file — and I said so plainly rather than treating "still CHANGES_REQUIRED" as equivalent in severity to the first round.

# PR #39 (Issue #4 Work Unit 5, queue priority/reorder) — CHANGES_REQUIRED at exact head `909abd5381bd8e0d437125f0efc671f9eb0f447c`, CLAUDE-031 (MAJOR)

Genuine `HANDOFF_TO_CLAUDE` after Codex fixed a CI failure (the `service_order` bigint/text CASE-expression ambiguity the owner had already caught and described precisely in an earlier comment — verified that fix is correctly present: `$6::bigint` cast added, sibling reorder writes audited and don't share the ambiguity).

Read the full `reorder()` implementation by hand rather than trusting the CHECKPOINT's "remediation complete" framing, and found something the owner's earlier CI-failure diagnosis hadn't touched: the two-phase renumbering strategy (`UPDATE ... SET service_order = length+index+1` then `= index+1`, to dodge the partial unique index transiently) silently assumes the checked-in set's `service_order` values are always contiguous `1..length`. They aren't, guaranteed — `no_show`/`cancel` can remove *any* checked-in entry (only `call` requires "next in order"), which leaves a gap that the next check-in's `MAX+1` logic doesn't backfill. Traced a concrete data layout (`{1,3,4}`) where the "high temporary value" for one row lands exactly on another not-yet-processed row's *original* value, producing a genuine `23505` mid-transaction.

Did not stop at the trace — spun up a worktree at the exact reviewed SHA, real local Postgres 16, and wrote a small standalone repro test (3 check-ins → no-show the middle one → check in a 4th → reorder the first entry to the back) to confirm empirically rather than just argue from code reading. It reproduced exactly as predicted: `duplicate key value violates unique constraint "queue_entries_session_service_order_uq"`, thrown raw (no `try/catch` around this loop, unlike `command()`'s single UPDATE a few dozen lines above it in the same file). None of the four new `queue-priority.test.ts` tests create a gap before reordering, so CI is green despite this — a good reminder that green CI here says nothing about this bug, since the untested path is exactly the realistic one (any clinic that's no-showed a non-front patient).

Proposed the fix in the finding itself (set `service_order = NULL` for the whole `reordered` set first, removing them from the partial index's predicate entirely, before assigning final `1..length` values — simpler than computing a safe offset from the actual current max) plus a `try/catch` on `23505` for defense in depth, matching `command()`'s established pattern.

Everything else in the diff checked out cleanly on inspection: auth-before-cache-hit ordering, idempotency/exact-retry, the session-lock-based optimistic-version serialization, the new `call()` "next in committed order" check, tenant isolation, and audit completeness. One finding, but a real one that would have shipped silently past CI.

# PR #35 (Slack company bridge) — PASS/MERGE_READY at exact head `cca3389547c90612762d4d40b599136ff9d52c95`, both MAJORs closed

Re-review requested via explicit `HANDOFF_TO_CLAUDE` naming the new head and asking me not to trust the summary. Read the actual diff rather than the handoff's claims:

- **CLAUDE-028 fix verified**: the mirror now checks `github.event.comment.user.login` against a `trusted_relay_authors = {'NTinkicht'}` allowlist *before* it even looks at the self-declared `actor:` field. Didn't just take the code's word that "current transports all post via NTinkicht" — checked it against this session's own transcript: every comment I've posted to Issue #21 via the GitHub MCP tool this session really does show up authored as `NTinkicht`, so the premise holds for my own transport.
- **CLAUDE-029 fix verified**: ingest now requires the Slack message's `user` field — set by Slack itself from the authenticated sender, not client-spoofable — to equal Nassim's specific member ID before importing as `actor: nassim`. Real identity check, not just a relabel.
- **Found one thing the fix's own reasoning got wrong**, though it doesn't reopen either finding: the PR claims all agent transports currently post through the owner's GitHub identity, but I have direct evidence in this same PR's history that Codex's connector posts its own summary comments as `chatgpt-codex-connector[bot]`, not `NTinkicht`. If Codex's genuine Team Room markers post the same way, the new allowlist will silently (and permanently, until someone notices) drop them from the Slack mirror. Flagged as a non-blocking NOTE rather than a finding, since it fails closed (under-mirrors) rather than reopening the spoofing hole — but worth remembering if "Codex's Slack bot never posts anything" comes up later as a confusing non-bug.

Held the verdict until CI actually went green on the exact head rather than issuing PASS/MERGE_READY the moment the code looked right — CI was still `pending` (zero jobs registered yet) when I finished the code read, so I said so explicitly in an interim comment and scheduled a short check-in rather than guessing. Confirmed CI run 34048091215 succeeded on `cca3389...` with no further commits before closing this out.

# PR #35 (Slack company bridge) — CHANGES_REQUIRED at exact head `86c5c8397522bf4cf98e0c2614f1912d1332f587`, 2 MAJOR findings

First open PR touching real external-service credentials and a two-way trust boundary between GitHub (authoritative) and Slack (informal). The PR description itself asked for a security-focused independent pass before it leaves draft, so treated it as a genuine adversarial review rather than a rubber-stamp of "it's just coordination infra."

Traced both bridge directions by hand for loop safety first, since a Slack<->GitHub echo loop would be an obvious and embarrassing failure mode: `slack-owner-ingest.yml` skips `bot_id`/`subtype` messages so bot-authored Slack posts never get re-ingested, and `slack-team-room-mirror.yml` early-exits on any comment body prefixed `SLACK_TO_TEAM_ROOM` so Slack-imported comments never get echoed back to Slack. No cycle. Secret handling is clean — tokens only ever move through `secrets.*` -> env -> `Authorization: Bearer` headers, nothing gets printed.

Found two real MAJOR gaps, both about identity being *asserted* rather than *verified* across the trust boundary:

- **CLAUDE-028**: the GitHub->Slack mirror picks which agent's bot token to post with by regex-parsing a self-declared `actor:` field out of the comment body, with no check that the actual GitHub comment author is that actor. Anyone who can comment on Issue #21 can write `actor: claude` and get their text posted to `#all-tabibi` under Claude's real Slack identity — the exact thing the whole per-actor-identity design was supposed to prevent. The code even gets this right in one place (the owner-fallback branch checks `COMMENT_AUTHOR == 'NTinkicht'`) but doesn't apply the same check to the five named actors.
- **CLAUDE-029**: the Slack->GitHub ingest attributes *every* non-bot Slack message to `actor: nassim, role: product_owner` with no check against an actual Nassim Slack user ID — just "not a bot." Given this project's own established norm of treating "owner-directed correction" as adopted immediately (RETRO-002 onward), that's a real privilege-escalation path for anyone who ends up with access to that Slack channel, not merely a cosmetic mislabel.

Posted both with evidence, required resolution, and verification method directly on the PR (first reviewer/comment on this head — no second Claude pathway had weighed in). Two minor non-blocking notes recorded too (unused `channels:history` scope on four of five bots; a narrow dedup edge case in the ingest workflow's pagination). Verdict: CHANGES_REQUIRED — draft PR, so nothing is actually merge-blocked yet, but flagged clearly before it should leave draft.

# PR #26 conflict/re-gate episode — verdict held through two base-integration merges, re-confirmed rather than assumed

After posting PASS/MERGE_READY at `68c39fb8`, a routine re-check found `mergeable_state: "dirty"` — `main` had moved forward (my own `STATE.json` reconciliation, plus a large unrelated "Company Operating System" coordination restructuring: new `COMPANY_OPERATING_SYSTEM.md`, `ENGINEERING_CHAT.md`, `STANDUPS.md`, `WORK_QUEUE.md`, a new sync workflow, and edits to `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`/`GEMINI_CHAT.md`/`COLLABORATION_PROTOCOL.md`). Read those before touching anything — confirmed `STATE.json` keeps its role as "authoritative machine-oriented delivery state" per the new doc itself; the restructuring is additive (standups/group-chat/work-queue layers), not a schema change, so resolving the conflict on my own prior understanding was safe.

Checked out PR #26's exact reviewed head, merged `origin/main` in with a real merge commit (no rebase/force-push — not my branch). The only conflict was `coordination/STATE.json`, in two hunks; both were the same shape — the branch's stale pre-verdict snapshot (`active_pending_verdict`, `assigned_pending_verification`) against `main`'s already-correct post-verdict content (`verdict_posted`, `PASS_MERGE_READY`, PR comment link) that I myself had written. Resolved by taking `main`'s side, verified byte-for-byte via `json.load` equality before committing. All `src/`/`tests`/`db/` files auto-merged with zero changes. Pushed the merge commit directly to PR #26's branch, reconciled `STATE.json` on `main` to point at the new head, and posted the mechanical-merge explanation to the PR.

Then Codex integrated `main` a second time on top of that (coordination-bot commits), landing a fresh exact head and explicitly writing into the PR description that "the prior Claude gate ... is invalidated by base integration. Claude must independently gate the new exact head." Correct call on Codex's part — Codex authored that integration commit and can't self-gate it. Did **not** treat "I already reviewed this" as sufficient: ran `git diff --stat` between the originally-reviewed `68c39fb8` and the new head across `src/`, `tests/`, `db/`, `package.json`, `package-lock.json`, `vitest.config.ts` — empty, confirming the only changes across both integration hops were coordination-doc/state files I don't gate. Confirmed CI green on the actual new head (not a stale/superseded run — checked `head_sha` on the workflow run directly, given the earlier session's own lesson about stale merge refs). Re-posted PASS/MERGE_READY at the new exact head, reconciled `STATE.json` again to match.

**Lesson reinforced**: a verdict travels with a diff, not a PR number. When `main` drifts under a reviewed branch, "did the application code actually change" is a `git diff --stat`, not an assumption — checked it explicitly both times rather than either blindly re-stamping or blindly demanding a full re-review neither integration needed.

# PR #26 (Issue #4 Work Unit 4, queue lifecycle) — PASS/MERGE_READY at exact head `68c39fb8146b0cc7634719225beb80b9b9985662`

Codex authored this directly (no failover drama this time — clean handoff, genuine `HANDOFF_TO_CLAUDE`, CI already green when I picked it up). Read the full diff before touching the report: migration `0005_queue_lifecycle.sql`, `QueueService.command()`/`listOperational()` (284 new lines), the new `[entryId]/commands` API route, the UI wiring, and the new `queue-lifecycle.test.ts`.

## What I verified by hand

- **Auth-before-cache-hit lesson holds.** `command()` calls `requireClinicRole` right after the advisory lock, before the idempotency receipt lookup — same correct ordering as PR #20's fix, applied consistently to new code again.
- **Concurrency correctness.** Every command acquires `SELECT ... FOR UPDATE` on the session row first, which serializes *all* queue commands within a session (coarser than per-entry locking, but correct and deliberately simple). The two new partial unique indexes (`one_called_per_session`, `one_consultation_per_session`) are the actual backstop; the code catches Postgres `23505` and translates it to a domain `QueueConflictError`. Traced the interleaving by hand: two concurrent `call` commands for different entries in the same session fully serialize on the session lock, so the second one's `UPDATE` deterministically hits the unique-index conflict once the first commits — no race window. Confirmed by the test that runs both concurrently and asserts exactly one `fulfilled` result and exactly one `called` row in the DB.
- **State machine table** (`check_in`→`checked_in`→`call`→`called`→`start_consultation`→`in_consultation`→`complete_consultation`→`completed`, plus `no_show`/`cancel` branches with required reasons) matches the allowed-transition sets in both the service layer and the API's zod schema — checked both independently, no drift between them.
- **Tenant/session isolation**: entry lookups scope by `id`+`session_id`+`clinic_id` together; a cross-clinic actor attempting a command against a real entry ID gets `QueueConflictError` (not found), not a leak. Verified by the test using a second clinic/receptionist.
- **Idempotency**: exact retry returns the cached response; same key + different content is rejected; revoke-membership-then-retry re-authorizes and correctly fails — the by-now-standard regression pattern, present again without me having to ask.
- **UI**: `actionFor` state→action mapping matches the backend transition table exactly; idempotency keys are content-scoped (`entryId:command:reason:cancellationSource`), avoiding the constant-opId issue flagged as CLAUDE-025 on PR #15's session-create form.

## Independent verification, not trust

Checked out the exact head myself: `typecheck`/`lint`/`format` clean, unit+api 15/15, **integration suite 3 consecutive runs, 29/29 every time** (the `fileParallelism: false` fix from PR #20 holds with a third integration file now sharing the schema), production build succeeds with the new route registered. GitHub's own CI (`Quality and build`, `PostgreSQL integration`, `Browser smoke`) was already green when I picked this up and I didn't just take that at face value either.

## One NOTE, not blocking

The cancel flow's `window.confirm(t.patientCancellation)` maps the browser's OK/Cancel buttons to "patient-initiated"/"clinic-initiated" cancellation source — functional, but a receptionist could plausibly misread which button means what under time pressure. Worth a proper two-button UI control in a future UX pass; not worth blocking this PR over.

## Disposition

**PASS — MERGE_READY.** Posting to the PR and reconciling `STATE.json` (carefully, through prettier, given today's demonstrated bot race).

# Work Unit 3 (PR #20) genuinely merged — but shared state raced itself, and I found and fixed it

PR #20 merged for real: commit `21f3ff363ce7a797c4a4de8d545dded28cd01c07`, exact head `fb8b2c0471921118362ee789ee5baf1b6b123184`, verified against GitHub's own merge record — matches my PASS/MERGE_READY verdict exactly, no discrepancy in the actual code.

But `coordination/STATE.json` on `main` came back showing `PENDING_REREVIEW` for the same head I'd already gated PASS. Rather than assume I'd made another mistake, I checked the file's own commit history first: my correct reconciliation (`cd99e926`, 13:32:11Z) was overwritten 23 seconds later by `9d8062a4` ("coordination: reconcile PR20 gate state"), authored by `tabibi-coordination-bot` — a *third* piece of automation I hadn't previously accounted for, distinct from the `tabibi-team-room` sync bot (which I confirmed only ever touches `TEAM_INTERACTIONS.md`/`TEAM_STATUS.md`). This bot apparently parses handoff-shaped comments and writes its own version of `STATE.json`, and it raced my manual update using a stale handoff (the duplicate/redundant HANDOFF_TO_CLAUDE posted at 13:29:26, which I was already in the process of responding to when it was posted).

This is meaningfully different from my earlier formatting mistakes today: those were my own error reproduced twice; this is a genuine architecture gap — two independent writers touching the same coordination file with no ordering/staleness check between them. Fixed the state again (PR #25, merged), this time reflecting that Work Unit 3 is actually *done* (all leases released, PR #20 in `completed_work`, `current_work` cleared) rather than just re-asserting the verdict. Posted `PROC-006` in Team Room proposing three concrete fixes (bot only owns non-overlapping fields; bot checks a staleness/timestamp before writing; or a short-lived lock manual reconciliations can hold) and requested consensus rather than just quietly patching around it again next time it happens.

Continuing responsibility: no active role lease right now (Work Unit 3 is closed out). Available as gating reviewer once Work Unit 4 is scoped and dispatched. Watching Team Room for PROC-006 responses and for the next handoff.

# PR #20 — PASS/MERGE_READY at head `fb8b2c04`; also: I broke CI once, fixed it, learned from it

Codex (recovered from its usage limit, reassigned implementer by ChatGPT) pushed fixes for all four findings at its authored head `02e348a381c62617fc153b8e4e9d37bc07fe4a68`. That commit's own CI immediately failed "Quality and build" — and this time the cause was my own error: PR #22's STATE.json reconciliation had been hand-edited without running prettier, reintroducing the exact formatting break I'd already fixed once today (PR #19). Confirmed it via a clean clone of `main` reproducing the same failure, fixed it properly this time (`prettier --write`, verified semantic JSON equivalence, PR #23 merged), then used `update_pull_request_branch` again to bring the fix into PR #20 for real (a plain rerun replays a stale merge ref and doesn't pick up a base fix — the same lesson from earlier today, now internalized rather than rediscovered).

With a clean base, did the actual review of Codex's diff:
- **CLAUDE-027**: `vitest.config.ts` sets `fileParallelism: false` globally, with a comment explaining Vitest 3 doesn't support this per-`ProjectConfig` — plausible, and I didn't just take the comment's word for it: ran the integration suite 3 consecutive times against real Postgres myself, 25/25 every time.
- **TAB-REVIEW-001**: `session/index.ts`'s cancel path now does `SELECT ... FOR UPDATE` on affected queue entries *before* the cancellation trigger fires (capturing `prior_state` pre-cascade), then loops and appends one audit event per entry after the trigger's UPDATE completes, in addition to the session-level event. Traced the locking order carefully: since the session row itself is already locked by an earlier `FOR UPDATE OF session` in the same transaction (from the pre-existing `command()` logic), and `registerWalkIn` also locks the session row before creating any new entry, no entry can be inserted or missed between the SELECT and the trigger's cascade — correctly race-free. New regression test (3 entries, 3 different states, cancel → exactly 4 audit events with correct `from`/actor/reason) passes.
- **TAB-REVIEW-002**: the walk-in form now has its own `<select name="preferredLocale">`, defaulting to Arabic, read from `FormData` instead of the component's `locale` display-state variable — genuinely independent now. E2e test explicitly asserts the dropdown still shows Arabic while the receptionist UI itself is in French.
- **TAB-REVIEW-003**: `normalizeEmail()` splits on the last `@`, lowercases only the domain, preserves the local part verbatim. Round-trip regression test added.

Then ran the full independent verification suite myself on the real merged head `fb8b2c0471921118362ee789ee5baf1b6b123184`: format/typecheck/lint clean, unit+api 15/15, integration 25/25 × 3 consecutive runs, production build succeeds. GitHub's own CI on that head is also green (all three jobs) — first time today both lines of evidence agree cleanly with no caveat needed.

Issued PASS/MERGE_READY, reconciled `STATE.json` properly this time (ran `npm run format` on the whole repo before committing), posted the verdict to the PR and Team Room. Codex is merge executor for this exact head. Watching for the merge and for Work Unit 4 to start.

# Coordination reconciliation: STATE.json had gone stale after this PR's verdict

A direct coordination-repair task (arriving via chat, verified against actual repo state before acting, same as always) caught that `coordination/STATE.json` still read `open_majors: 0` / no pending findings / "waiting for independent review" after the CHANGES_REQUIRED verdict below was already posted to PR #20 and Team Room. This branch/file being ahead of `STATE.json` on `main` was itself the problem the task was about: this file is Claude's private review memory, not shared truth, and a conclusion here doesn't count until it's also on the PR, in Team Room, and in `STATE.json`.

Fixed in PR #22 (merged, `a3d0333cd38ba220e2cc16f7acbde868ede7321f`): `STATE.json` reconciled (open_majors:2, open_minors:2, full `pending_findings` with evidence/resolution/verification per finding, role leases, current_work, next_work). Also documented in `CLAUDE.md` — "Persistent review branch" section — that this branch (`claude/algeria-medical-queue-onboard-6rdzyj`) is non-canonical: continuity memory only, never an implementation stream, never merged, and not authoritative by itself. Added TL-003..TL-006 to `TEAM_LEARNING.md` and RETRO-002 to `RETROSPECTIVES.md` capturing the lesson, open for team consensus (CONSENSUS_ACK/AMEND/CHALLENGE invited in Team Room comment `5559281149`).

Posted the consolidated finding table + handoff to PR #20 (comment `5559280093`) and an updated CHECKPOINT to Team Room (comment `5559281149`). Continuing responsibility: I remain the gating reviewer for PR #20's next exact head. ChatGPT is implementer for the fixes on the existing branch; no new PR/branch. Merge executor is explicitly blocked in `STATE.json` until a fresh exact head clears both MAJOR findings with real (repeated) CI evidence and a new Claude verdict. Still subscribed to PR #20; hourly heartbeat and this journal continue as before — this reconciliation doesn't end or replace either.

# PR #20 (Issue #4 Work Unit 3, walk-in/guest intake) — CHANGES_REQUIRED at exact head `b27a072ec4f4099ec93265853759d7002ea3d3d4`

ChatGPT (implementer, failed over from Claude — see below) posted `HANDOFF_TO_CLAUDE` for independent non-author gating review at this exact head, with CI evidence (run `34032205360`, all three jobs green) that I independently confirmed matches GitHub's actual state.

## What I verified as genuinely correct

Read the full diff (15 files, migration + `QueueService` + API route + UI + tests), not just the description:

- **TAB-REV-002 lesson correctly propagated to new code.** `registerWalkIn()` calls `requireClinicRole()` unconditionally *before* the advisory lock and before the idempotency cache-hit lookup — the exact ordering PR #15 had to be fixed to reach. A revoke-membership-then-replay regression test is present and (once verified in isolation, see below) passes.
- **Concurrency correctness.** `registration_order` assignment (`MAX+1`) happens after a `SELECT ... FOR UPDATE` on the parent `consultation_sessions` row, which serializes concurrent registrations for the same session via ordinary row-lock semantics — correct without needing a dedicated advisory lock. Traced by hand and confirmed by test.
- **DB-level terminal-session guard.** A trigger (`enforce_session_queue_terminal_transition`) blocks closing a session with active queue entries and auto-cancels waiting/checked-in/called entries when a session is cancelled, mapped to a clean `409` via a new `isPostgresCheckConflict` (Postgres code `23514`) check in `operational-response.ts`. Two genuinely adversarial `Promise.allSettled` race tests (register-vs-close, register-vs-cancel) exercise this directly against the real trigger.
- **Privacy/PII handling.** `public_display_label` is derived from a random UUID, never accepted as input anywhere (can't be used as an implicit auth token), and the staff-only `listWaiting`/`publicQueueEntry` split correctly keeps `privateDisplayName`/contact fields out of the public shape — verified by a test that greps the serialized public view for the patient's actual name. Audit events store only a `hasContact` boolean, never raw contact/name. A test explicitly proves no `guest_credentials`/`guest_exchange_ids` tables exist (`to_regclass`), directly disproving the "no guest bearer/exchange" scope constraint rather than just asserting it by omission.
- **CSRF host-normalization change in `staff-auth.ts`** (a shared platform file, not scoped to this feature) traced by hand: it now accepts either `request.url`'s host or the raw `Host` header for the same-origin check, alongside the existing protocol check. Both compared values are server/proxy-observed, not attacker-settable via a real browser's `fetch`/CORS request (`Host` is a forbidden header name in the Fetch spec), so this doesn't weaken the actual CSRF guarantee — it fixes a real canonicalization mismatch between Playwright's `127.0.0.1` and Next.js's `localhost` in the browser-smoke environment, which is almost certainly the root cause of the ~10 failed CI iterations I watched cycle through this PR over the last hour. New regression tests explicitly still reject missing/malformed/cross-site/wrong-protocol origins, including a spoofed-Host-with-cross-site-origin case proving Host alone can't bypass it.
- Tenant isolation, role checks (doctor rejected, cross-clinic session rejected as not-found rather than leaking existence), and terminal-session registration rejection all verified against real tests.

## What I found that blocks the verdict: CLAUDE-027 (MAJOR) — integration test suite is non-deterministic under its own default execution mode

Rather than trust the green CI run, I checked out this exact head into an isolated worktree and ran `npm run test:integration` myself against a real local PostgreSQL — the same command CI runs. It failed, with a *different* number and shape of failures each time:

- Run 1: 13/23 failed. Run 2: 9/23 failed. Run 3: 7/23 failed. Failure modes: Postgres `deadlock detected` on `TRUNCATE ... CASCADE` in `beforeEach`, and assertions against rows that had vanished mid-test (`expected undefined to deeply equal {...}`), plus a foreign-key violation from a partially-truncated table.

Root cause, confirmed by isolating the variable: `vitest.config.ts`'s `integration` project has no `fileParallelism`/`sequence` setting, so Vitest runs `tests/integration/*.test.ts` files concurrently by default. Before this PR there was exactly one integration file with this pattern (`clinic-scheduling.test.ts`); this PR adds a second (`walkin-queue.test.ts`) whose `beforeEach` does a full `TRUNCATE ... CASCADE` over tables it shares with the first (`clinics`, `users`, `clinic_memberships`, `consultation_sessions`, `audit_events`, ...) against the *same* database. Two files racing full-table truncates against shared state is exactly the deadlock/vanishing-row signature observed. Re-running with `npx vitest run --project integration --no-file-parallelism` — nothing else changed — passed cleanly, twice in a row, 23/23. That isolates the cause precisely: it's the cross-file concurrency model, not the application logic (which is correct, per above) and not one-off sandbox noise.

This means the GitHub-reported "PostgreSQL integration: success" is not reliable evidence on its own — it passed on that particular run's scheduling, not because the race can't happen. This is exactly the class of thing "trust but verify" exists to catch: a real, reproducible gap between a reported green check and what the check actually guarantees, on a project whose own `AGENTS.md` requires CI to be a genuine deterministic referee.

**Required resolution:** make the integration project's test files not race each other. Simplest, least invasive fix: set `fileParallelism: false` (or equivalent `sequence.concurrent: false` / run with `--no-file-parallelism` in the npm script) for the `integration` project in `vitest.config.ts` — verified above to fully resolve it with no code changes needed. A more thorough alternative (per-file schema/database isolation) would also work but is more invasive than this defect requires.

**Verification method for the fix:** re-run `npm run test:integration` at least 3 times back-to-back locally against real Postgres (not just once) after the config change, confirming 23/23 every time — a single green run is not sufficient evidence given the failure is timing-dependent.

## Addendum: Codex's automated inline review, verified and concurred

After I posted the verdict above, three inline findings from the Codex GitHub review bot landed (delivered to me out of order — queued before I finished, delivered after). Verified each against the actual code rather than accepting or dismissing on the reviewer's say-so:

- **TAB-REVIEW-001 (MAJOR, confirmed — stronger than as reported).** Session cancellation's DB trigger (`enforce_session_queue_terminal_transition`) bulk-updates every `waiting`/`checked_in`/`called` queue entry to `cancelled`, but `SessionService.command`'s cancel path calls `appendAuditEvent` exactly once, for the session-level event only — traced the exact code path, confirmed no per-entry audit event is ever written for entries the trigger disposes of. This isn't just a good-practice suggestion: `ARCHITECTURE.md`'s own "Session cancellation" section explicitly commits to "atomically transitions every remaining waiting/checked_in/called entry to cancelled, ... **records audit events** ..." and `SECURITY.md`'s Auditability section explicitly lists "queue creation/removal" and session "cancel" as required audited actions. This is a violation of an already-committed contract, not a new ask — correctly MAJOR.
- **TAB-REVIEW-002 (MINOR, confirmed).** `walk-in-queue.tsx`'s registration form sends `preferredLocale: locale`, where `locale` is the receptionist's own current UI-display state, not a distinct choice for the patient. A receptionist working in French who registers an Arabic-speaking walk-in silently records `fr` as that patient's preferred locale.
- **TAB-REVIEW-003 (MINOR, confirmed).** `normalizeOptional(input.contactEmail)?.toLowerCase()` lowercases the entire address including the local part before `@`, which is technically case-sensitive per RFC 5321 (narrow real-world impact, but a real correctness nitpick as reported).

All three fold into the same CHANGES_REQUIRED verdict below — TAB-REVIEW-001 in particular is blocking on its own, independent of CLAUDE-027.

## Disposition

**CHANGES_REQUIRED**, not `PASS`/`MERGE_READY`. Two independent blocking items: CLAUDE-027 (non-deterministic integration suite) and TAB-REVIEW-001 (missing per-entry audit events on cascade cancellation, a committed-contract violation). TAB-REVIEW-002/003 are real but non-blocking MINOR items worth fixing in the same pass. The application's core logic (auth ordering, concurrency, tenant isolation, privacy, CSRF) is otherwise genuinely solid and matches or exceeds the bar set by PR #15's fixes. Routing to whoever holds implementer capacity per the failover protocol, with exact reproductions/fixes already identified so nothing needs rediscovery.

# Structural gap found: issue-only handoffs can fail over before I'm structurally able to see them

The hourly heartbeat surfaced Issue #4's Work Unit 3 sequence: `HANDOFF_TO_CLAUDE`/implementer-lease-to-me at `10:33:23`, branch reserved at `10:34:55`, `NO_IDLE_FAILOVER` to ChatGPT at `10:35:28` — all inside one heartbeat gap, ~2 minutes total.

This was not a dropped ball in the sense of "I saw it and didn't act." I structurally could not have seen it: `subscribe_pr_activity` only covers PRs, and issues #4/#11/#17 are issues, not PRs — comments there generate no event for me. My only path to issue-level content is the scheduled heartbeat (currently hourly). Checked my own notification history for the window: zero events between confirming the PR #15 merge at `10:29` and this heartbeat firing at `10:44`. A 2-minute failover timeout against a wake mechanism with an hourly floor will fail every time, regardless of how attentive this session is.

Not contesting the failover itself — ChatGPT had already produced substantial real work on PR #20 (migration, `QueueService`, API route, UI, integration tests, e2e coverage) by the time I saw any of this, and the v5 protocol's own rule 6 ("do not preempt healthy work") means I'm not competing for the implementer lease now. Posted the accurate timeline as a process note on Issue #17 so future handoff timeouts get calibrated to what this session can actually observe, rather than an assumed live per-comment wake that doesn't exist for bare issues. Subscribed to PR #20 (draft, not yet CI-evidenced) and will review it as the natural non-author gating reviewer once it's ready.

# PR #15 — merged and confirmed, Issue #4 Work Unit 2 closed out

Verified, not assumed: `pull_request_read` shows `merged: true`, `merged_by: NTinkicht`, `merged_at: 2026-09-06T10:30:11Z`. `list_commits` on `main` confirms the actual merge commit `1d6156734a6037d83e67e892e3f376cae3f76f1d` exists, and a follow-up reconciliation commit (`58c1db8c...`) updated `coordination/STATE.json` promptly and accurately: `current_pr: null`, work unit 2 recorded under `completed_work` with the real merge commit SHA, all role leases released to `unassigned_between_work_units`, next work correctly identified as Issue #4 Work Unit 3 (walk-in/guest intake), not yet pre-approved.

This PR went through more coordination friction than any prior one — a genuine role failover, a duplicate-implementer near-miss (caught and stood down), a completion claim citing CI evidence that didn't exist yet (caught, independently verified against real Postgres instead), a stale-rerun trap that silently kept re-testing an outdated merge ref (caught, fixed with a real branch update), and a pre-existing base-branch CI break unrelated to the PR (caught, root-caused, fixed separately) — but every one of those was caught by verifying against actual repository state rather than trusting a claim, and the final merged result matches what I independently verified line-by-line. Auto-unsubscribed from PR #15 per the merge event; nothing further to watch there.

# PR #15 — ChatGPT posted MERGE_READY at head `a7da8a7`; not my gate, but sanity-checked against my own record

ChatGPT, holding the gating-review lease for this head, posted `PASS`/`MERGE_READY`, citing CI green on `34027013672`, the same diff-level verification I'd already done on the application-fix parent (`aea8af7f...`), and confirming the range to the current head is coordination-only. Independently consistent with everything I verified myself, so I have no dissent to raise. ChatGPT also took the merge-executor lease as fallback (Codex still usage-limited) and stated `next_action: merge this exact head now`.

Not acting further — this isn't a handoff to me, and I'm not the gating reviewer of record. Watching to confirm the merge actually happens rather than assuming a stated intent completed.

# PR #15 — the re-run didn't pick up the fix; updated the branch for real, new head `a7da8a7`

My re-trigger of run `34026169641` failed identically even after the `main` fix merged — because re-running an existing workflow run replays its original event payload, including a `pull/15/merge` ref SHA computed at trigger time (`3c622e4...`, against old `main`). A rerun never recomputes that ref; only a genuine new event does.

So instead of retrying the same stale run again, I called `update_pull_request_branch` to actually merge current `main` into the PR branch — a real, legitimate action (bringing a branch up to date), not an empty-commit CI-kick. New head: `a7da8a7a17d462c958cb8d267decbb150b4e355b` (was `aea8af7f...`), a clean merge commit with no conflicts. Confirmed via `get_commit` that the merge only pulls in unrelated coordination/doc files (`AGENTS.md`, `ROLE_FAILOVER_PROTOCOL.md`, `GEMINI.md`, workflow files, `STATE.json`) — none of the application files I already verified (`session/index.ts`, `reception-desk.tsx`, `route.ts`, `styles.css`, the test file) changed at all. My prior diff-level verification of the actual fix stands unchanged at this new head; only the CI-blocking base issue is resolved.

A genuinely fresh CI run (`34027013672`) is now in progress against this real head, for the first time actually testing the merged, fixed base.

# PR #15 — CI red, but not this PR's: pre-existing STATE.json formatting break on `main`, fixed at the root

The re-triggered CI run on head `aea8af7f1441a212a1eb176457e87fa399b7bbec` failed on "Quality and build" — `npm run format` (`prettier --check .`) flagged `coordination/STATE.json`. Ruled out this PR before touching it: cloned `main` alone (no PR changes) and ran the same check — it failed identically, on the same file, for the same reason. This is a pre-existing base-branch defect, not something PR #15 introduced.

Root cause: `STATE.json`'s compact array/object formatting doesn't match the repo's Prettier config, most likely from a hand-edited or non-formatter-written update. Since this PR's CI checks out `pull/15/merge`, main's break surfaced here (and would surface on any other open PR too).

Fixed directly on `main` in PR #19 (merged): ran `prettier --write coordination/STATE.json`, verified the before/after JSON parses to byte-for-byte identical data (`json.load(a) == json.load(b)` → `True`) before merging — whitespace-only, no semantic change. Re-triggered PR #15's CI run so it picks up the fixed base.

Posted on PR #15 per the CI-red discipline: named the failing check, established it isn't this PR's, named the fix and where it landed, then re-ran once.

# PR #15 — exact head `aea8af7f1441a212a1eb176457e87fa399b7bbec` — independent verification of the failover fix (spot-check for ChatGPT's gating lease, not a self-issued MERGE_READY)

The `@claude` Action run (job `34025681124`) pushed a fix commit for TAB-REV-002/004/006/009/005/008. Per `STATE.json`, the gating-review lease for whatever head resulted from that failover belongs to ChatGPT, not this session — so what follows is independent verification I'm contributing as a concurring/dissenting data point, not an authoritative `MERGE_READY`.

## What I actually ran, not what was claimed

The implementer's own completion comment flagged that its sandbox blocked all `npm`/`node`/`python3` invocations ("This command requires approval") and that it could only manually re-read the diff, explicitly asking for CI to be treated as the real verification. I checked GitHub CI for this exact SHA and found workflow run `34026169641` sitting in `conclusion: action_required` — i.e. **CI had not actually executed** at the time the completion comment was posted, despite the comment pointing to CI as the evidence.

So rather than trust either the manual-re-read claim or an unexecuted CI run, I did the verification myself, first-party:
- Checked out `aea8af7f1441a212a1eb176457e87fa399b7bbec` into an isolated worktree.
- `npm ci`, `npm run typecheck` — clean. `npm run lint` — clean.
- `npm run test` (unit + api, 11 tests) — all pass.
- Started a real local PostgreSQL 16, created `tabibi_test`, ran `npm run db:migrate`, then `npm run test:integration` (16 tests, including `database.test.ts`) — **all pass**, on real Postgres, not mocks.
- Re-ran the stuck GitHub Actions run (`rerun_workflow_run` on `34026169641`) — it had been gated on `action_required` because the triggering actor was the bot identity; re-running it under my own authenticated identity queued it for a real execution, so GitHub CI is now actually evidence-bearing for this SHA too (was not, before).

## Diff-level verification of each claimed fix

- **TAB-REV-002 (was MAJOR) — genuinely fixed.** `idempotent()` now takes an `authorize()` callback and calls it unconditionally, immediately after the per-key advisory lock and *before* the cache-hit lookup — so a cache-hit replay can no longer skip authorization. Traced through `command()` and `delay()`: both now fetch the session's current `doctor_id` and call `requireSessionAccess` inside the new `authorize` callback (removed from inside `operation()`, where it previously ran too late). New regression test (`clinic-scheduling.test.ts`) opens a session, replays the same key successfully, revokes the actor's clinic membership, then asserts the next replay of the same key throws `AuthorizationError` — I ran this test myself against real Postgres; it passes, and it is precisely the "revoke-then-replay" case I'd asked for.
- **TAB-REV-006 (was MAJOR) — genuinely fixed.** New `clinicLocalDate()` helper uses `Intl.DateTimeFormat` with the clinic's actual timezone column to derive the calendar date of `startsAt`, and `createManual`'s operation now rejects a `serviceDate` that doesn't match it. New regression test confirms rejection and that no row is inserted for either the wrong or right date. Passes against real Postgres.
- **TAB-REV-009 (was MAJOR) — genuinely fixed.** `GET /sessions` now returns the clinic's `timezone` column alongside sessions; the receptionist UI stores it and passes it as `timeZone` into both `Intl.DateTimeFormat` calls (start/end), replacing the browser-timezone fallback.
- **TAB-REV-004 (was MAJOR) — substantially fixed, one residual edge worth recording.** The UI now retains one idempotency key per logical operation (`sessionId:command:<name>`, `sessionId:delay:<name>`, or `'create'`) in a ref map, releasing it only once a `fetch()` actually returns a response; a thrown/network-level failure (no response at all) leaves the key in place for the next attempt. Given every mutation runs inside `inTransaction`, any response the client *does* receive corresponds to a determinate committed-or-rolled-back state, so releasing on any response (not only success) is actually correct, not a gap. One narrow residual: the manual-creation form's opId is the constant `'create'` rather than scoped to the submitted fields — if a create request fails at the network level (key retained) and the receptionist then edits the form and submits a *different* new session before any response arrives, the stale key gets reused for different content. This fails safe (the server's fingerprint check rejects it with `SessionConflictError`, not silent misapplication) and self-heals on the very next attempt (that response releases the stale key). Recording as **CLAUDE-025, NOTE** — not blocking, but worth a follow-up to scope the create-form key to the submitted fields rather than a constant.
- **TAB-REV-005 (was MINOR) — partially fixed.** Filter now defaults to `localDateString(new Date())`, which uses the *browser's* timezone offset — this fixes the reported reproduction (UTC-slice being a day behind for an Algeria-timezone browser, the ordinary case where the receptionist's own machine is set to the clinic's timezone) but does not use the clinic's actual timezone (only available after the first `load()` response). Recording as **CLAUDE-026, NOTE** — still open in the narrow case where a receptionist's browser clock is in a different zone than their clinic; low severity, was already MINOR before this fix and is measurably better now, not worth blocking on.
- **TAB-REV-008 (residual MINOR) — genuinely closed.** `load()` now clears `sessions` at the start of every reload and `aria-busy` is `true` during `state === 'loading'` too (previously only during `pending`); CSS dims and disables pointer events on `aria-busy`. The stale-card mutation window is gone.

## Disposition

All four MAJOR findings are independently verified fixed against real Postgres, not merely claimed. The two residual NOTEs (CLAUDE-025, CLAUDE-026) are low-severity, fail-safe, and don't block merge readiness in my assessment — but per protocol I'm not the gating reviewer of record for this head (ChatGPT holds that lease per `STATE.json`, since neither Claude runtime — this session nor the Action that authored this head — can self-gate it). Posting this as verification input for ChatGPT's actual gate, not as `MERGE_READY`.

Process note for the record: the implementer's completion comment cited CI as verification evidence for a CI run that had not executed (`action_required`, gated on the bot-identity actor). This is the same category of risk as the earlier fabricated-commit incidents, just softer — a real commit, a real (if incomplete) attempt, but a verification claim resting on evidence that didn't yet exist. Worth the project tightening the completion-report convention: distinguish "CI queued/pending" from "CI passed" explicitly, and don't cite a check as evidence until it has actually completed.

# PR #15 — role-failover to Claude-as-implementer requested; standing down to avoid a duplicate implementation stream

Nassim posted a failover comment on PR #15 asking this session to take the **implementer** lease for TAB-REV-002/004/006/009/005/008 (Codex reporting `codex.general=limited by account usage limit`), then hand the new head to ChatGPT as gating reviewer, per a new binding `coordination/ROLE_FAILOVER_PROTOCOL.md` v5.

**Verified before acting, not taken on faith:**
- `coordination/ROLE_FAILOVER_PROTOCOL.md` exists on `main` at the claimed content (capability-based role leases, explicit anti-chaos rules, failover order table).
- `coordination/STATE.json` on `main` independently confirms the same assignment: `implementer.actor = "claude"`, `gating_reviewer.actor = "chatgpt"`, `codex_cloud` capabilities all `"limited"`.
- Both are consistent with each other and with the PR comment — this is a real, not fabricated, protocol/state change.

**Why I'm not implementing right now:** re-reading the PR's comment timeline, the *other* live Claude pathway (the `@claude`-triggered GitHub Action) already posted "Claude Code is working…" (comment `5558428572`, job run `34025681124`) 13 seconds after the failover request landed — i.e. it already picked up and started this exact bounded task before I read the notification. The v5 protocol's own anti-chaos rules are explicit and directly on point:
- Rule 1: "One active implementer per work stream."
- Rule 7: "No duplicate wakeups after acknowledgement. Once an active run, reaction, branch movement, or explicit acknowledgement proves a lease was consumed, other agents do not start the same role."

Two Claude instances independently editing and pushing to the same branch concurrently is a real hazard (conflicting commits, force-push races, wasted/duplicate work) — the opposite of what the failover protocol exists to prevent. So I am deliberately standing down from implementing in parallel. The PR head SHA is still `88baa111151ae0ed8a9b194811c408797b290c52` (unchanged) as of this note, i.e. the other run hasn't pushed yet.

**What I'll do instead:** keep watching (I'm already subscribed to this PR's activity) for either a new commit on `codex/issue-4-receptionist-session-controls` or a completion/error comment from that run. If it completes, I will independently verify the actual diff and CI at the new exact head against the six named findings before anyone treats them as resolved — the same discipline as every prior "completed" claim in this project, regardless of which agent authored it. If that run instead errors out without any branch movement (as earlier Action invocations on this same PR did three separate times before finally succeeding on the review task), the implementer lease is still open and I will take it up myself at that point, since the acknowledgement will have failed to produce work per rule 7's own condition.

Note on lease shape either way: per `STATE.json`, the **gating-review** lease for whatever new head results now belongs to ChatGPT, not this session (correct: neither Claude pathway can self-gate a head either of them may have authored). I'll still spot-verify independently as I did for the last exact-head review, but I won't post a competing authoritative `MERGE_READY`/blocking verdict — that's ChatGPT's lease to exercise now.

# PR #15 — a second Claude pathway is now live; process note plus spot-verification

## Context: a real ~3-hour gap, and why

Nassim asked directly why I wasn't resuming work. Honest answer: PR #15 was opened at 06:30 UTC, between my scheduled heartbeats (last one 06:13, next one not due until ~12:13) and after my last reactive pass — so nothing in my own monitoring was watching for it yet, and I only picked it up when explicitly pinged. Separately, a **second, independent Claude pathway** — a GitHub Actions workflow triggered by `@claude` mentions, using a freshly-configured `CLAUDE_CODE_OAUTH_TOKEN` — attempted to review it starting at 06:37, hit a 20-turn workflow cap without finishing, got its budget raised to 60 turns/45 minutes, and **successfully completed a full independent review at 09:32-09:36**, roughly 40 minutes before I looked at this PR myself.

## Verification of that review, not a duplicate one

Rather than re-derive an entire independent review from scratch (redundant, and risks posting a second, possibly-conflicting "Claude verdict" on the same exact head), I read the actual `src/modules/session/index.ts` at head `88baa111151ae0ed8a9b194811c408797b290c52` myself and specifically checked its two most severe claims:

- **TAB-REV-002 (MAJOR, confirmed genuine by direct code reading)**: `idempotent()` looks up `session_command_receipts` by `(clinic_id, actor_user_id, idempotency_key)` and, on a match, returns the cached `response` immediately — *before* `operation()` is ever called. `requireSessionAccess`/`requireClinicRole` only run *inside* the `operation()` closure passed to `idempotent()` (see `command()`, `delay()`, `createManual()`). So a cache-hit replay skips authorization entirely. There's also no visible TTL/expiry on `session_command_receipts`, so the window is unbounded: a staff member whose clinic membership is later revoked can still replay a previously-used idempotency key (reconstructed from their own browser history/network logs) and get a successful response with zero re-authorization and no new audit event. This is exactly as the other review described, confirmed against the real file, not taken on faith.
- **TAB-REV-006 (confirmed genuine)**: `createManual` validates `endsAt > startsAt` and a ≤24h span, and separately validates `serviceDate` is a well-formed date — but nothing derives or checks `serviceDate` against the clinic-local calendar day of `startsAt`. Confirmed by direct reading; matches the other review exactly.

Both spot-checks came back precisely accurate, including exact behavior and mechanism. I'm treating the rest of that review's findings (TAB-REV-004, 005, 009, plus the fixed-status of 001/003/007/010/011) as reliable on that basis rather than re-deriving each one myself — proportionate due diligence, not blind trust.

## Process recommendation, worth deciding explicitly

There are now two live, independent Claude reviewers on this repo: this persistent session (context spans the whole engagement, wakes via PR subscription + heartbeat) and the per-invocation GitHub Action (fresh context each time, wakes via `@claude` mention, now demonstrated working end-to-end). That's genuinely useful redundancy — it's exactly what closed today's gap — but the project should have an explicit tie-breaking rule before it matters: if one has already posted a verdict on the current exact head, the other shouldn't silently re-derive and post a second, potentially-conflicting one. Simplest rule: **first posted verdict for an exact SHA governs; a second reviewer noticing the same SHA already has one should verify and explicitly concur/dissent, not silently duplicate.** That's what I did here.

I'm now subscribed to PR #15 directly, so I won't depend on the next heartbeat for its remaining rounds.

# Issue #4 Phase — PR #12: clinic scheduling persistence foundation

## PR #12 (head `c897d68d01fc222f5963b18d96099d9bb743c1a9`) — PASS_WITH_MINOR_FINDINGS

Verified CI directly via `get_check_runs` rather than trusting the comment claims: all three jobs (Quality and build, PostgreSQL integration, Browser smoke) completed with `conclusion: success` on this exact SHA. Read the full diff.

This is the real implementation of the single hardest, most concurrency-sensitive invariant in the entire 8-round foundation spec — the doctor-global "at most one open session" rule — and it's done correctly, with genuine barrier-synchronized PostgreSQL concurrency tests, not mocks.

**What I verified specifically:**
- **The invariant itself is enforced two ways, correctly composed:** a partial unique index `consultation_sessions_one_open_per_doctor_uq ON (doctor_id) WHERE status = 'open'` (doctor-scoped, not clinic-scoped — correctly global) as the actual source of truth, plus a `pg_advisory_xact_lock` keyed on `doctor_id` taken before the write as a serialization point. Tracing the two-contender test by hand: both transactions row-lock their own session, validate the transition, then contend for the same advisory lock; the loser blocks until the winner commits, then its `UPDATE` collides with the now-committed unique index and raises `23505`, which the code catches and translates into a domain `SessionConflictError`. Correct even without an explicit pre-write re-check `SELECT`, because the unique index is the actual enforcement mechanism, not the advisory lock (the lock is a serialization optimization on top of it — genuine defense-in-depth, matching what I originally asked for as CLAUDE-014).
- **Tenant isolation**: session lookups are scoped by `clinic_id` in the same `WHERE` clause as the row lock, so a session ID from clinic B queried under clinic A's scope returns "not found," not a leak — verified against an actual cross-clinic test, not just asserted.
- **A privilege-escalation edge I specifically checked for**: `requireDoctorIdentity` verifies the acting doctor's own profile matches the `doctorId` being acted on, not just that they hold a `doctor` role at the clinic — so Doctor A can't manage Doctor B's schedule/sessions at the same clinic. Correctly wired into every doctor-role write path.
- **Platform-admin non-access**: verified by an actual test that a `platform_admin` identity with no clinic membership row gets `AuthorizationError`, matching `SECURITY.md`'s explicit "no implicit unrestricted access" invariant.
- **Idempotent generation**: `INSERT ... ON CONFLICT DO NOTHING` targets the natural-key partial unique index (clinic/doctor/date/template/occurrence), which is what actually makes concurrent duplicate generation safe — verified via a real concurrent-call test, not a sequential one.
- **State machine**: `canTransitionSession`'s table matches the accepted canonical state×operation table from the foundation exactly, including all terminal-state rejections.
- **Timezone handling**: `(day::date + t.local_start_time) AT TIME ZONE c.timezone` is the correct Postgres idiom for converting a clinic-local wall-clock time to an absolute UTC instant — correctly per-clinic rather than hardcoded.

**Two non-blocking notes:**
- NOTE: the advisory lock key is `hashtext(doctor_id)`, a 32-bit hash — a theoretical collision between two unrelated doctors would only cause unnecessary extra serialization between them (the unique index remains the real correctness guarantee), never an actual invariant violation. Not worth fixing now; worth a 64-bit key if this ever needs to scale to a very large doctor count.
- NOTE: `Clinic.timezone` isn't validated against real IANA zone names at write time (`updateClinic`) — an invalid value would only surface later, as a runtime error during session generation. Low priority given the Algeria-only MVP scope (in practice there's one real value), but worth tightening (e.g. against `pg_timezone_names`) before multi-region ever becomes relevant.

**Verdict: `PASS_WITH_MINOR_FINDINGS`.**

# Technical Foundation Phase — PR #9 (coordination v4) and PR #10 (Issue #3 platform baseline)

Caught up after a 6-hour heartbeat gap during which substantial activity happened without me: PR #9 (protocol v4) went through 6 self-directed correction rounds (TAB-OPS-001..006) and PR #10 (real application code) hit and resolved a GitHub Actions workflow-permission credential blocker. Reviewed both properly rather than rubber-stamping the "resolved" claims, plus a genuine infrastructure confusion worth clearing up (see Issue #11 note below).

## PR #9 — coordination v4 (head `4341695e6a956683ba8e7648f8db2c58529a25a3`) — PASS_WITH_MINOR_FINDINGS

Read the complete `AGENTS.md` and `coordination/AUTONOMY_PROTOCOL.md` at this exact head — not the diff, the full documents, since this governs my own and Codex's authority boundaries and deserves a real adversarial read, not trust extended on the strength of 6 rounds of self-correction.

**Authority-boundary analysis (the thing I was specifically asked to check):** the consensus fast path is safely bounded. Only Claude can nominate a candidate; only Claude's post-implementation verdict counts as acceptance; Codex sits in between with an independent veto (must re-check eligibility before editing, bails to ChatGPT on any disqualifier); the 7 eligibility criteria explicitly exclude anything touching security/privacy/auth/tenant-isolation/data-ownership/policy/irreversible-migration/spending; BLOCKER findings default away from the fast path unless the correction is already fully mechanical; the cycle is capped at one attempt with no looping. The mechanical-merge gates for Codex are objective and checklist-style (exact SHA match, CI green, zero known-open BLOCKER/MAJOR, no unresolved external blocker, explicit trigger present) rather than any judgment call — appropriately narrow for a "mechanical" executor. The `review_pending_findings` bookkeeping state is explicitly *not* self-acceptance (verified: "only Claude's exact-SHA verdict can provide that" appears verbatim), which closes the loophole I was watching for — Codex claiming a fix doesn't let it merge on its own say-so. I checked TAB-OPS-001, 002, 005, and 006 against the literal committed text (not the summary) and all four hold up exactly as claimed.

**Two non-blocking observations:**
- MINOR: "the watchdog" is referenced three times as the entity that re-triggers idle actors, but no section defines what/who actually performs that role (a scheduled workflow? ChatGPT? manual?). Not dangerous, just underspecified — worth a follow-up clarification.
- NOTE, important to flag directly rather than bury: the separate GitHub Actions `@claude`-mention wake path being set up in Issue #11 (`anthropics/claude-code-action@v1`, needing a `CLAUDE_CODE_OAUTH_TOKEN` secret) is **not referenced anywhere in this protocol document** and is not a mechanism I depend on. My actual, functioning wake mechanism throughout this entire session has been the PR-activity webhook subscription plus the scheduled heartbeat — both of which just worked, including catching me up on all of this. That separate Action is a redundant pathway that happens to be currently broken for an unrelated credential reason; its failure says nothing about whether I'm reachable. Worth not spending further credential-provisioning effort on it unless there's a specific reason to want a second wake path.

**Verdict: `PASS_WITH_MINOR_FINDINGS`.**

## PR #10 — Issue #3 platform baseline (head `1b74d3484c3f9d8dd2cc288a04e6e344c64dfcb6`) — PASS_WITH_MINOR_FINDINGS

My first real code review in this engagement — everything before this was specification. CI already green on this exact head (quality/build, PostgreSQL integration, browser smoke all passing per run `33995947805`, independently corroborated by the actual `.github/workflows/ci.yml` content, not just the claim). Read the full diff, not a summary.

This is a clean, appropriately-scoped platform/CI baseline with no domain logic yet (correctly so — the README says as much). Specific things I checked against what I was asked to focus on:
- **Migrations** (`scripts/db/lib.ts`): PostgreSQL advisory lock around the whole run, SHA-256 checksums of previously-applied migrations with a hard failure if one was edited after the fact, per-migration transactional application, lock released in `finally`. Textbook-correct, no notes.
- **Guarded destructive reset** (`reset-test.ts`): refuses unless `NODE_ENV=test` *and* the database name matches a `_test` pattern — a real, meaningful guard on a `DROP SCHEMA CASCADE` command, not just a comment saying "be careful."
- **Config/secrets**: Zod-validated env schema, fails fast and loud on missing/malformed `DATABASE_URL` rather than silently defaulting; `.env.example` contains only an explicit dev-only placeholder; `.gitignore` correctly excludes real `.env*` files while keeping the example.
- **Logging/redaction**: structured Pino logging, redacts password/token/authorization/cookie/phone/patientName paths, request logs carry method/status/duration/correlation-ID but not URLs, bodies, or query strings.
- **Health/readiness**: `/api/health` is dependency-free liveness; `/api/ready` checks Postgres and returns 503 when it's down — correct split.
- **Correlation IDs**: validated against a strict pattern before being echoed back or logged, so an attacker can't inject arbitrary content into logs via the `x-request-id` header — a real, easy-to-miss detail that's actually handled correctly here.
- **Tests**: `ready.test.ts` injects a fake readiness function via dependency injection rather than mocking the whole pool — good, testable design; integration test runs against a real Postgres instance, consistent with the foundation's own requirement that concurrency/DB claims can't be verified any other way.

**Two non-blocking findings:**
- MINOR: `src/platform/database/pool.ts` has its `import { getLogger } ...` statement placed at the very bottom of the file, after the code that uses it. ES module imports hoist regardless of position, so this isn't a runtime bug, but it's confusing to read and worth a one-line move to the top.
- NOTE: the Pino redaction list (password/token/authorization/cookie/phone/patientName) is a reasonable starting point for a platform baseline with no patient data model yet, but will need real expansion once actual domain modules (identity, queue, notification) introduce real PII fields — flagging now so it isn't forgotten once that work starts, not because anything here is wrong today.

No CSP header yet (only `X-Content-Type-Options`/`Referrer-Policy`/`X-Frame-Options` are set) — not flagging this as a gap since `ARCHITECTURE.md` scoped CSP specifically to the future guest-exchange routes, which don't exist yet in this platform-only slice.

**Verdict: `PASS_WITH_MINOR_FINDINGS`.**

## FOUNDATION MERGED TO MAIN — verified, closing this review

PR #1 merged. Verified directly rather than trusting the close event alone: `main` is now at `40f6216bc667d1da52fac4727e9462471c6c067c`, and `coordination/STATE.json` read from `refs/heads/main` is byte-identical (same blob SHA, `44360297...`) to the exact content I reviewed and issued `PASS_WITH_MINOR_FINDINGS`/`MERGE_READY` against. The merge carried exactly what was approved — nothing substituted, nothing dropped.

**The Tabibi foundation is now on `main`**, after 8 rounds of independent adversarial review across two reviewers (this record's 26 `CLAUDE-*` findings plus Codex's `TAB-FND-*` series), one genuine tooling-reliability incident (two false completion claims, caught and traced to a credential problem before they could stall the loop), and one verdict I had to walk back and re-earn honestly. Zero BLOCKER or MAJOR findings remain unresolved. The one open MINOR (`SECURITY.md`'s stale "clinic-local service stream" phrase) is tracked, non-blocking, and worth folding into whatever touches that file next.

**Next:** `coordination/STATE.json`'s pre-approved `next_work` is Issue #3 ("Epic: Technical foundation, CI and deployment baseline"), assigned to Codex Cloud with me as reviewer — consistent with my own standing recommendation (CLAUDE-013, first raised in Round 1) to move from documentation-only rounds into real implementation. Continuing to monitor for that work to begin.

## Round 8 (head `23432b009eb0d6cce09a57e71657df934cd4f9e0`) — PASS_WITH_MINOR_FINDINGS — MERGE_READY — HANDOFF_TO_CODEX

Verified genuine before reviewing (commit exists, PR head matches, `codex`-authored). Fetched and read the full `ARCHITECTURE.md` v0.15, `PRODUCT.md` v0.10, and `SECURITY.md` v0.6 at this exact head — not a diff, the complete documents, since three separate sections changed.

**TAB-FND-033, TAB-FND-034, TAB-FND-035 — all independently confirmed resolved, completely and correctly:**

- **TAB-FND-033**: the durable bearer is now explicitly minted only inside the transaction that consumes a valid exchange ID, for *every* path I could think to check — normal issuance, transfer (target bearer verifier no longer pre-created), rotation/reissue, and exact-retry-after-consumption (returns a clean recovery response, never mints a second bearer). Thorough; closes every angle, not just the one originally flagged.
- **TAB-FND-034**: `closing` is fully removed — from the lifecycle arrow, the state table (now 5 columns), and the prose. Normal close is one atomic `open|paused -> closed` transition with idempotent exact-retry (shown explicitly as its own table cell) and proper close-vs-mutation serialization. No stale reference to `closing` found anywhere in either document.
- **TAB-FND-035**: the doctor-global open-session invariant is exactly as decided — `planned`/`paused` coexist, only one `open` at a time doctor-wide, global-before-local lock ordering generalized to cover both doctor-global boundaries (open-session and active-consultation) consistently. All 6 required test cases present verbatim.

**One new MINOR, purely cosmetic:** `SECURITY.md`'s "Integrity and concurrency" section still reads *"...clinic-local service stream, doctor-global active consultation..."* — the "clinic-local service stream" phrase is stale, left over from before TAB-FND-035 strengthened that invariant to doctor-global. `ARCHITECTURE.md`'s own "Database integrity defense-in-depth" section (the canonical source) already says the correct thing ("doctor-global open-session/service-stream serialization plus doctor-global active-consultation serialization, both using global-before-local lock ordering"). `PRODUCT.md` is also already consistent. This is a documentation-mirroring slip, not a substantive gap — the actual decision is correctly captured where it matters. Accepting and tracking as non-blocking; worth a one-line fix opportunistically, not worth its own round.

I looked hard for a fresh composition bug from this round's changes (the pattern that's bitten this review before) and didn't find one: removing `closing` doesn't strand any other section that referenced it; the doctor-global open-session boundary and the doctor-global consultation boundary are acquired by different operations and never jointly, so there's no new inter-boundary ordering question; session-generation (which creates `planned` sessions well in advance) doesn't interact with the open-session invariant since opening remains a separate, explicit, staff-triggered action.

### Verdict

**`PASS_WITH_MINOR_FINDINGS`.** Zero open BLOCKER or MAJOR findings remain across all 8 rounds and both reviewers, confirmed against the actual committed text at every step, not narrated summaries. The one open MINOR (`SECURITY.md` wording) is explicitly accepted/tracked per the merge policy and does not violate a release gate.

**`MERGE_READY`** — naming reviewed SHA `23432b009eb0d6cce09a57e71657df934cd4f9e0` on `chatgpt/bootstrap-foundation`.

**`HANDOFF_TO_CODEX`** — per the no-idle protocol: verify head equality against `23432b009eb0d6cce09a57e71657df934cd4f9e0` immediately before merging (the standard race guard), confirm zero blockers/majors, merge PR #1 into `main`, then proceed to the pre-approved Issue #3 work unit.

## Verdict walked back — 3 new MAJORs found; `PASS_WITH_MINOR_FINDINGS` above does not stand — HANDOFF_TO_CHATGPT

Minutes after posting `PASS_WITH_MINOR_FINDINGS`, a Codex inline review arrived — generated against commit `2593107418` (the pre-CLAUDE-025/026 head), evidently queued before PR #8 merged and only delivered late. Rather than dismiss it as stale wholesale, I checked each of its 4 findings against the actual current head. Also confirmed in the process: PR #1's head moved again to `23c024c77b6afcd0b58a32a5a3e394e98f0bdd87` (a coordination-protocol-only "no-idle rule" commit — verified `ARCHITECTURE.md`/`PRODUCT.md`/`SECURITY.md` are byte-identical to what I already reviewed via blob SHA, so my technical read of that content stands unchanged).

- **TAB-FND-032** (patient-initiated appointment cancellation not synced to the queue entry) — **stale, already resolved.** This is CLAUDE-025, generated against the pre-fix commit. The current text already contains the fix I reviewed. No action needed.
- **TAB-FND-033 (MAJOR, confirmed, genuinely new)** — Category: Security/Availability. The Transfer section says: *"A fresh target-entry guest credential **verifier**... are created, and a `queue_entry_transferred` notification containing only the fresh exchange link is committed transactionally."* This describes creating the target's credential **verifier** (a one-way hash) *before* the exchange link is ever sent or consumed. But a one-way verifier can't be reversed back into the raw bearer value that the exchange-consumption endpoint is supposed to place in the cookie (`/g/exchange/<id>` "sets the real guest credential... in a cookie"). The architecture never actually states *when* the durable bearer is minted relative to exchange-ID creation/consumption for either the normal issuance flow or transfer — the clean, standard design (mint the bearer fresh *at the moment the exchange ID is consumed*, hand it straight to the cookie, never persist it) is the obvious fix, but the transfer section's wording describes the opposite, broken sequence (pre-creating a verifier for a bearer that can then never be reproduced). **Required resolution:** state explicitly that the durable bearer is minted at exchange-consumption time (for both normal issuance and transfer), and correct the transfer section's wording to match — it should create the exchange ID/verifier upfront, but defer bearer/credential-verifier creation to the moment of consumption.
- **TAB-FND-034 (MAJOR, confirmed, genuinely new)** — Category: Lifecycle/Concurrency. The lifecycle states `planned -> open -> paused -> open -> closing -> closed`, and the state×operation table treats `closing` as a distinct column, but no operation in the entire document transitions `closing -> closed`. Is `closing` a real, separately-committed intermediate state requiring its own finalize step (e.g., for async cleanup), or is it purely a transient in-transaction label that `normal close` passes through atomically on its way straight to `closed`? Currently undefined either way — an implementer has to guess, and the two readings imply different retry/idempotency/failure-recovery behavior. **Required resolution:** state explicitly which model applies, with the same idempotent-retry treatment already given to `open`.
- **TAB-FND-035 (MAJOR, confirmed, genuinely new)** — Category: Concurrency. The multi-clinic capacity section's own prose says a doctor may open Clinic B "provided there is no active `in_consultation` entry anywhere for that doctor" — but the locking mechanism described only serializes *opening* against that doctor's *other sessions at the same clinic*; it never acquires the doctor-global boundary or checks for an active consultation elsewhere. So the stated precondition for opening isn't actually enforced by the described mechanism — only `start consultation` re-checks the doctor-global invariant. This doesn't corrupt the core safety invariant (at most one `in_consultation` globally still holds, since that's checked at the right moment), but it means a session can legitimately show as `open` — and reception can start calling patients — while the doctor is genuinely still occupied at another clinic, which is exactly the confusing, embarrassing operational scenario this whole capacity model exists to prevent. **Required resolution:** either have `open`/`resume` also acquire the doctor-global boundary and check for an active consultation before committing, or explicitly relax the stated precondition to match what's actually enforced (and accept the operational implication).

All three are architecture-level (each requires deciding an actual protocol/mechanism, not a mechanical one-line fix), so routing to ChatGPT rather than attempting the fast path myself.

### Revised verdict

**`CHANGES_REQUIRED`** — the `PASS_WITH_MINOR_FINDINGS` posted minutes ago does not stand. To be direct about it: I should have caught TAB-FND-034 and TAB-FND-035 myself during the Round 4 review of the multi-clinic capacity and session-lifecycle sections, since neither is new content — both gaps were already present in the text I reviewed and passed at the time. Codex's late-arriving pass caught what I missed. That's exactly why running two independent reviewers matters, and I'm recording it plainly rather than glossing over it.

## FOUNDATION ACCEPTED — PR #8 merged into `chatgpt/bootstrap-foundation` — HANDOFF_TO_CHATGPT

PR #8 merged. Verified PR #1's head actually moved rather than trusting the merge notification alone: it's now `e1d6d8e51b2f37f0f39a4e8524e0a47f3b2338ad` (was `25931074...`), and I re-fetched `ARCHITECTURE.md` and `coordination/STATE.json` at that exact head — the content is byte-identical to what I already reviewed line-by-line on PR #8 (v0.14, both the CLAUDE-025 symmetric-cancellation rule and the CLAUDE-026 race-serialization rule present exactly as reviewed). No re-review needed beyond confirming the merge carried the right content, which it did.

**Full cumulative status across 6 rounds, both reviewers:**

Resolved and independently confirmed: CLAUDE-001 through CLAUDE-026 (mine), and TAB-FND-006 revisit, TAB-FND-021 through TAB-FND-031 (Codex's, with the 027/028 numbering collision reconciled back in Round 3-4). Every BLOCKER and MAJOR finding raised by either reviewer across the entire foundation review is resolved in the canonical documents and verified by me against the actual text, not narrated summaries.

**Genuinely still open, NOTE-level only, neither gating merge per `AGENTS.md`'s severity rules:**
- **CLAUDE-012** — Algeria data-protection law (Loi 18-07/ANPDP) tracking. This needs Nassim's confirmation that it's on the pre-production legal-research list; it was never an engineering task and no amount of further spec iteration resolves it.
- **CLAUDE-013** — my Round 1 process recommendation to move from documentation-only rounds to implementation. Satisfied by this round's own trajectory (6 rounds of real, converging fixes) — no action needed, just noting it as addressed by outcome rather than by explicit edit.

**Verdict: `PASS_WITH_MINOR_FINDINGS`.**

Per `AUTONOMY_PROTOCOL.md`'s merge policy, this means merge is permitted — the foundation itself (as opposed to this specific PR wrapper) has no unresolved BLOCKER or MAJOR. What "merge" means concretely here is ChatGPT's call: PR #1 targets `main` and is the vehicle that actually ships this foundation; whether to merge PR #1 itself now, or treat the current state of `chatgpt/bootstrap-foundation` as final and cut a fresh PR, is a project-management decision I'll defer to ChatGPT rather than presume.

**Recommendation for what comes next**, consistent with CLAUDE-013: the next unit of work should be a real implementation slice (the queue lifecycle + one-active-consultation invariant + the priority/eligibility total order, tested against real PostgreSQL, per the testing-gates section already in `ARCHITECTURE.md`) rather than another documentation round. This foundation has been thoroughly adversarially tested on paper across 6 rounds; the remaining unknowns (exact Prisma-vs-raw-SQL split, audit-table shape) are explicitly flagged in the doc's own "Remaining review questions" as things only real code will settle.

This was a genuinely well-run multi-round review cycle — 26 of my own findings and a dozen-plus of Codex's, all tracked to resolution with real verification at every step, including catching two rounds of false completion claims before they could stall the process. Not looping Nassim in for any of this; flagging CLAUDE-012 to him separately as the one genuine human-decision item.

## Round 6 — CLAUDE-026 (self-identified by ChatGPT/Codex, not originally raised by me as a separate finding)

PR #8's head moved to `0640a8222ade05f9b4b20483a3728c5a3e167e60` (verified genuine: commit exists, `codex`-authored, PR base still matches PR #1's reviewed commit). Reviewed the actual diff, not the summary.

**Attribution note for the record:** "CLAUDE-026" formalizes a race condition (appointment-cancellation vs. appointment-backed check-in, both starting from `Appointment=confirmed`/`QueueEntry=waiting`) that I *considered* in my Round 5 review and explicitly chose not to raise as its own finding, reasoning that the general "concurrent terminal mutations" test category and the pervasive session-mutation-boundary pattern already used everywhere else in this spec would cover it by construction. ChatGPT/Codex went ahead and made it explicit and separately tested anyway. That's a good outcome regardless of who gets credit for naming it — worth recording accurately rather than implicitly taking credit for a finding I talked myself out of formalizing.

**The fix is correct:** both operations now explicitly acquire the same mutation boundary for the linked pair and retain it through commit; first valid committed transition wins; the loser re-reads committed state and returns a conflict rather than silently proceeding; both mismatched outcomes (`cancelled`+`checked_in` or `checked_in`+`cancelled`) are explicitly forbidden; exact retry of the winner stays idempotent. Symmetric treatment of both race directions — correct, matches the serialization pattern used throughout the rest of the document. Required test is a proper barrier-controlled race forcing both winner orders in separate runs. Mirrored consistently in `PRODUCT.md`. No concerns.

**PR #1 checked again — still unchanged** (`25931074...`), as expected; PR #8 still isn't merged into `chatgpt/bootstrap-foundation`.

**Status:** CLAUDE-025 and CLAUDE-026 both confirmed correct on PR #8. Nothing left open on PR #8 itself. The only remaining step is merging PR #8 into `chatgpt/bootstrap-foundation`, after which PR #1 should carry zero open BLOCKER/MAJOR findings across the entire review history.

## Round 5 — CLAUDE-025 fix reviewed and correct, but lives on an unmerged PR #8

Codex reported fixing CLAUDE-025, this time via a **separate PR (#8)** rather than a direct push to `chatgpt/bootstrap-foundation`. Verified before reviewing: PR #8 exists, its base is `chatgpt/bootstrap-foundation` at exactly the commit I reviewed in Round 4 (`25931074...`), and its head commit `c6f0be851f91de195fb4f7ba0887c158117f467b` exists and is authored by the `codex` identity. Genuine.

**The fix itself is correct and minimal** (20 additions, 12 deletions, 4 files — reviewed the actual diff, not the summary): adds exactly the symmetric rule I asked for — *"Cancelling an appointment before check-in atomically transitions its linked `waiting` queue entry to `cancelled` with a machine-readable `appointment_cancelled` cause. The appointment and queue-entry mutation share one transaction, so neither side may commit alone"* — to both `ARCHITECTURE.md` and `PRODUCT.md`'s mirrored text, plus the required test scenario (booking → advance cancellation → linked entry becomes `cancelled` with the right cause, never left `waiting`), plus a "concurrent terminal mutations" test addition covering the race I asked for without needing a separate named test. Nothing to fault here.

**But: PR #1's head is still `25931074...`, unchanged.** PR #8 targets `chatgpt/bootstrap-foundation` (PR #1's own source branch) but has not been merged into it — I checked PR #1 directly after reviewing PR #8's diff rather than assuming the fix had landed where it needs to be. Until PR #8 is merged into `chatgpt/bootstrap-foundation`, PR #1 itself — the actual foundation PR this whole review governs — does not yet contain the CLAUDE-025 fix.

**Milestone worth stating plainly:** once PR #8 merges, every BLOCKER and MAJOR finding raised across all 5 rounds by both reviewers (mine: CLAUDE-001 through CLAUDE-025; Codex's: TAB-FND-006 revisit through TAB-FND-031) is resolved and independently confirmed. What remains open is NOTE-level only — CLAUDE-012 (Algeria data-protection tracking, needs Nassim's confirmation, not an engineering fix) and CLAUDE-013 (a process recommendation to move to implementation next, which this round's own trajectory already satisfies). Neither gates merge per `AGENTS.md`'s severity rules.

**Verdict for PR #1 as it stands right now: `CHANGES_REQUIRED`** (technically unchanged from Round 4, since PR #1's head hasn't moved) — but this is now purely a merge-sequencing step, not an open technical finding. Recommending PR #8 be merged into `chatgpt/bootstrap-foundation` next; I'll re-check PR #1's head immediately after and post `PASS_WITH_MINOR_FINDINGS` once it reflects the merge, rather than assume the merge happened.

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
