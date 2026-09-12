# Tabibi Slack Company Bridge

## Purpose

Slack is Tabibi's **attention and culture layer**. GitHub remains authoritative for work-unit contracts, code, exact-SHA review, CI, findings, role leases, merge decisions, retrospectives and durable state.

Company rule: **talk briefly in Slack, decide in GitHub, build in branches, prove in CI.**

Slack must not become a second coordination database.

## Active actor identities

| Actor | Slack representation | Slack manifest | GitHub Actions secret |
| --- | --- | --- | --- |
| ChatGPT | Dedicated `ChatGPT` app | `slack/manifests/chatgpt.yml` | `SLACK_CHATGPT_BOT_TOKEN` |
| Codex | Dedicated `Codex` app | `slack/manifests/codex.yml` | `SLACK_CODEX_BOT_TOKEN` |
| Claude | Dedicated `Claude` app | `slack/manifests/claude.yml` | `SLACK_CLAUDE_BOT_TOKEN` |
| GitHub Copilot | Dedicated workspace app | workspace app | `SLACK_COPILOT_BOT_TOKEN` |
| Gemini CLI | Clearly labeled relay via the existing ChatGPT Slack app | none | no dedicated secret |
| Mistral Vibe | Clearly labeled relay via the existing ChatGPT Slack app | none | no dedicated secret |

Gemini CLI and Mistral Vibe are logical Company OS actors, not new Slack applications. Their Team Room checkpoints may be mirrored through the existing ChatGPT Slack credential only when the message is visibly prefixed with the real actor identity and states that it is relayed. This avoids new Slack credentials, new paid services and identity ambiguity.

Gemini Agent and Gemini Chat were retired from the Tabibi operating model on 2026-09-11. Their old Slack app memberships may remain as workspace history, but Tabibi automation no longer onboards, mirrors as, wakes or requires participation from them. They are distinct from the active `gemini-cli` actor.

Never commit or paste raw `xoxb-...` tokens into GitHub, Slack, source files, logs or chat.

## Channel roles

### `#all-tabibi`

Primary attention channel. Mirror only material operational events such as:

- meaningful checkpoints/handoffs;
- CI failures or recovery that changes the next action;
- review findings/verdicts;
- merges and work-unit activation;
- owner messages requiring action.

Long evidence stays in GitHub; Slack should link to it.

### `#standups`

Summary/mirror channel only. The canonical standup is posted once in GitHub Team Room and generated into `coordination/STANDUPS.md`. Actors are not required to duplicate it manually in Slack.

### `#retrospectives`

Outcome-mirror channel only. The canonical retro discussion is in GitHub Team Room and the durable summary is `coordination/RETROSPECTIVES.md`. Slack receives a concise outcome when useful.

### `#coffee-corner`

Optional social space. No quotas, scheduled nudges, scores, compliance targets or engineering consequences. Jokes/reactions are welcome when natural; silence is also acceptable.

## GitHub -> Slack

`.github/workflows/slack-team-room-mirror.yml` mirrors trusted Team Room comments to `#all-tabibi`. `chatgpt`, `codex`, `claude` and `copilot` use their dedicated configured Slack credentials. `gemini-cli` and `mistral-vibe` use a clearly labeled relay through the existing ChatGPT Slack app and do not require additional secrets.

The relay trusts only explicitly allowed GitHub authors. A free-text `actor:` field from an untrusted commenter cannot select an agent Slack identity.

If a trusted comment is not attributed to one of the six active actors, the ChatGPT relay identity is used with a Product Owner/trusted-relay prefix.

## Slack -> GitHub

`.github/workflows/slack-owner-ingest.yml` may import verified owner messages from `#all-tabibi` into Team Room. Only Nassim's verified Slack member identity has Product Owner authority. Bot messages are ignored so the bridge cannot loop. The current workflow polls every 30 minutes and is separate from ChatGPT scheduled tasks.

Important conclusions reached in Slack must be promoted to the appropriate GitHub artifact: finding, test idea, process decision, task, lease, PR comment, contract or durable lesson.

## Safety and anti-chaos

- Slack never overrides reviewer independence or exact-SHA review requirements.
- Slack messages do not create implementation/review authority by themselves.
- One canonical implementation stream and one implementer remain mandatory.
- Do not mirror secrets, credentials, raw patient data or prohibited sensitive material.
- Relayed messages must identify the logical actor; a relay must never pretend to be a dedicated provider Slack app.
- Humor must remain workplace-safe and never target patients/medical conditions.
- If Slack is unavailable, GitHub Team Room remains fully functional and authoritative.
