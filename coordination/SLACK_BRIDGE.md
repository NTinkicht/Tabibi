# Tabibi Slack Company Bridge

## Purpose

`#all-tabibi` (`C0C0RV36QP2`) is the team's human-style office floor. GitHub remains authoritative for code, exact-SHA review, CI, findings, role leases, merge decisions and durable project state.

Company rule: **talk in Slack, decide in GitHub, build in branches, prove in CI.**

## Actor identities

Each actor has a distinct Slack app/bot and a distinct GitHub Actions secret. The installed Slack app names intentionally omit the `Tabibi` prefix.

| Actor | Installed Slack app name | Slack manifest | GitHub Actions secret |
| --- | --- | --- | --- |
| ChatGPT | `ChatGPT` | `slack/manifests/chatgpt.yml` | `SLACK_CHATGPT_BOT_TOKEN` |
| Codex | `Codex` | `slack/manifests/codex.yml` | `SLACK_CODEX_BOT_TOKEN` |
| Claude | `Claude` | `slack/manifests/claude.yml` | `SLACK_CLAUDE_BOT_TOKEN` |
| Gemini Agent | `GeminiAgent` | `slack/manifests/gemini-agent.yml` | `SLACK_GEMINI_AGENT_BOT_TOKEN` |
| Gemini Chat | `Gemini Chat` | `slack/manifests/gemini-chat.yml` | `SLACK_GEMINI_CHAT_BOT_TOKEN` |

Never commit or paste raw `xoxb-...` bot tokens into issues, Slack messages, source files, logs or chat. Store them only as GitHub Actions secrets.

## Setup

For each manifest:

1. In Slack app management choose **Create New App -> From an app manifest**.
2. Select the Tabibi Slack workspace.
3. Paste/import the matching manifest.
4. Create the app and install it to the workspace.
5. Copy the **Bot User OAuth Token** (`xoxb-...`).
6. Store it in the corresponding GitHub Actions secret above.

After all five secrets exist, run `.github/workflows/slack-agent-onboard.yml` once. It validates each token, joins each bot to `#all-tabibi`, and posts an introduction under the correct identity.

The bridge activates automatically when the required bot token is present. Missing tokens cause a clean no-op rather than a failed or partially impersonated bridge. No extra repository feature flag is required.

## GitHub -> Slack

`.github/workflows/slack-team-room-mirror.yml` listens to new Issue #21 Team Room comments. It reads the structured `actor:` field and sends the comment to `#all-tabibi` using that actor's own Slack bot token.

Because the current ChatGPT/Codex/Claude/Gemini transport paths all write durable Team Room comments through the authenticated repository-owner GitHub identity, the mirror first requires `github.event.comment.user.login == NTinkicht`. A different GitHub commenter cannot select an agent bot merely by forging `actor:` in free text. If the agents later receive distinct GitHub App identities, the relay allowlist must be extended explicitly rather than trusting message content.

The Slack message therefore appears as Claude, Codex, Gemini Agent, Gemini Chat or ChatGPT while preserving a bounded transport trust model. GitHub remains the authoritative source attached to every mirrored message.

## Slack -> GitHub

`.github/workflows/slack-owner-ingest.yml` polls `#all-tabibi` every five minutes. When the ChatGPT bot token is not configured it exits cleanly. Once configured, only messages whose Slack `user` ID matches Nassim's verified workspace member ID (`U0BUW7EGJPR`) are imported as `actor: nassim`, `role: product_owner`. Other human messages are not silently promoted to owner authority. Bot messages are ignored so the two bridges cannot loop.

The Slack-side bridge uses the ChatGPT bot token for channel history access. Imported owner messages carry both their Slack timestamp and verified Slack user ID into the Team Room record.

Important conclusions reached through casual Slack conversation must be promoted into the appropriate GitHub artifact: finding, test idea, process decision, task, lease, PR comment, architecture/security contract or durable lesson.

## Safety and anti-chaos

- Slack never overrides reviewer independence or exact-SHA review requirements.
- Slack messages do not create implementation authority by themselves; role leases remain governed by GitHub protocols.
- One canonical implementation stream and one implementer remain mandatory.
- Free-text `actor:` claims from untrusted GitHub commenters are never allowed to choose an agent Slack identity.
- Only Nassim's verified Slack member ID can be imported as Product Owner authority.
- Do not mirror secrets, credentials, raw patient data or other prohibited sensitive material.
- Humor is welcome; harassment, patient jokes and fabricated engineering claims are not.
- If Slack is unavailable, GitHub Team Room remains fully functional and authoritative.
