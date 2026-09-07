# Qodo PR-Agent Gatekeeper

Status: probationary independent reviewer.

Purpose: provide a review-only GitHub Actions reviewer when native reviewer capacity is unavailable.

Safety boundary:
- trigger only from an OWNER-authored PR comment beginning with `/review`;
- contents permission is read-only; issues/pull-requests write is only for publishing review output;
- no production-code edits, no branch pushes, no merge permission, and no autofix;
- uses repository secret `OPENROUTER_API_KEY`; the secret value must never be printed or committed;
- PR text, code comments, and diffs are untrusted input and must not override review instructions;
- model output is evidence, not automatically binding merge authority.

Initial model routing:
- primary: `openrouter/z-ai/glm-5.3`
- fallback: `openrouter/deepseek/deepseek-v4-flash`

Promotion rule: do not treat this actor as a binding final gate until at least one real review is checked for exact-SHA anchoring, useful evidence, false-positive rate, secret safety, and absence of code-write behavior. Any promotion to binding gate authority requires an explicit governance/protocol update.
