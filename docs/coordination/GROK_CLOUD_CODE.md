# SaveGrok: autonomous cloud code and independent review

This is the Tabibi-only integration for #339, #340 and WU116 #389. It adds a
**code-proposal transport** to the already-connected GitHub-polling
`tabibi-savegrok-review` Grok Bot routine. It does not replace the existing
review path, call the metered xAI API, use Slack, wake a Codespace or install
anything on the owner's PC. The provider routine must itself be updated through
the existing Grok Bot conversation; a GitHub PR cannot silently change it.

## Two non-overlapping modes in the same Bot

- **Review:** when an eligible owner-issued `ROLE_LEASE_ASSIGNED` has
  `actor: grok` and `capability: review`, independently inspect the
  exact-current-SHA non-Grok PR, its required three successful CI jobs and
  relevant changed code/tests. Post one deduplicated full-SHA review with
  source lease ID and grounded findings. Do not self-review, merge or deploy.
- **Implementation and tests:** when the canonical open PR has the latest
  owner-authored sole-implementer `ROLE_LEASE_ASSIGNED` with `actor: grok`,
  `capability: implementation`, `pr: #N`, `exact_sha: <40 chars>` and
  `stream: WU<N>`, and no release/cancellation/supersession, look for a
  bounded WU objective and allowed existing `src/` + `tests/` files.
  Do not touch any other branch, file, credentials, production service or
  workstream. On an existing PR, read and propose a small, concrete code AND
  regression-test edit. Never post a proposal if PR head changed since lease.

## Grok Bot proposal comment contract

The Bot publishes one **new top-level PR conversation comment** (not an
inline review) containing exactly this data, with the current lease comment's
numeric GitHub ID. All fields below must start at the beginning of a line.
The JSON is DATA, not instructions for GitHub Actions:

```text
GROK_CLOUD_CODE_PROPOSAL_V1
pr: 123
exact_sha: 0123456789abcdef0123456789abcdef01234567
stream: WU116
allowed_paths: src/path/existing.ts,tests/path/existing.test.ts
source_lease_id: 1234567890
objective: Make the tiny named change and add a deterministic test
BEGIN_TABIBI_PATCH_JSON
{"edits":[{"path":"src/path/existing.ts","old":"unique exact original","new":"exact replacement"},{"path":"tests/path/existing.test.ts","old":"unique existing assertion","new":"replacement assertion"}]}
END_TABIBI_PATCH_JSON
```

Use the **actual** PR, SHA, stream, source lease ID, objective and existing
leased files, not these placeholders. Two to four files total; at least one
`src/` and one `tests/` file; only a single unique old-text replacement
per file; no new files, shell commands, secrets or hidden changes. The
provider Bot must not claim that it ran tests just by proposing a patch.
GitHub Actions independently runs the repository's deterministic format,
lint, typecheck, tests and build before its trusted parent makes a normal,
non-force push on that same canonical PR.

The PR comment alone never establishes that Grok Bot authored it: the
provider currently connects GitHub as `NTinkicht`. Before considering cloud
coding proven, correlate the actual provider Run History, the lease comment,
proposal comment, Actions run, resulting `Material-Author: grok` commit,
three exact-new-head green CI jobs, and an independent **non-Grok** full-SHA
review. A missing provider run means provenance is **unverified**.

## Safety, idempotency and included usage

The GitHub workflow triggers only on owner-account comments on an **open PR**
with `GROK_CLOUD_CODE_PROPOSAL_V1`. The trusted parent validates its
target issue number, current same-repo PR head, source lease ID, active
sole-implementer lease, stream, strictly allowed existing files, symlinks,
hardlinks, old-text uniqueness, patch size and credential patterns. It
isolates model-proposed bytes from the write-token job, repeats lease/SHA
checks, tests the patch first, and cannot force-push. Every new head needs
fresh CI and a nonauthor reviewer. Dedupe at Bot level by PR + exact SHA +
implementation/review mode; do not retry a rejected proposal by repeating
the same comment. Block rather than preempt another implementer.

Provider-side included weekly usage and paid-on-demand OFF are owner/Bot
settings, **not** a claim verified by GitHub. Keep existing scheduled
10-minute cheap GitHub preflight and no paid fallback. If a Bot routine
requires per-write approval by provider policy, do not bypass it; use a
supported scoped allow rule if owner-authorized, otherwise report that
specific provider constraint. The model cannot approve a spending,
credential, legal or destructive-production decision.
