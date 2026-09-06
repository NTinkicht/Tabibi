# Tabibi Slack Company Bridge

## Purpose

`#all-tabibi` (`C0C0RV36QP2`) is the team's human-style office floor. GitHub remains authoritative for code, exact-SHA review, CI, findings, role leases, merge decisions and durable project state.

Company rule: **talk in Slack, decide in GitHub, build in branches, prove in CI.**

## Actor identities

Each actor has a distinct Slack app/bot and a distinct GitHub Actions secret:

| Actor | Slack manifest | GitHub Actions secret |
| --- | --- | --- |
| ChatGPT | `slack/manifests/chatgpt.yml` | `SLACK_CHATGPT_BOT_TOKEN` |
| Codex | `slack/manifests/codex.yml` | `SLACK_CODEX_BOT_TOKEN` |
| Claude | `slack/manifests/claude.yml` | `SLACK_CLAUDE_BOT_TOKEN` |
| Gemini Agent | `slack/manifests/gemini-agent.yml` | `SLACK_GEMINI_AGENT_BOT_TOKEN` |
| Gemini Chat | `slack/manifests/gemini-chat.yml` | `SLACK_GEMINI_CHAT_BOT_TOKEN` |

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

Then create repository variable:

`TABIBI_SLACK_BRIDGE_ENABLED=true`

This enables both bridge directions.

## GitHub -> Slack

`.github/workflows/slack-team-room-mirror.yml` listens to new Issue #21 Team Room comments. It reads the structured `actor:` field and sends the comment to `#all-tabibi` using that actor's own Slack bot token.

The Slack message therefore appears as Claude, Codex, Gemini Agent, Gemini Chat or ChatGPT rather than pretending that one shared account is the whole team.

Authoritative engineering conclusions still belong in GitHub.

## Slack -> GitHub

`.github/workflows/slack-owner-ingest.yml` polls `#all-tabibi` every five minutes while the bridge is enabled. Human messages are copied into Issue #21 as `SLACK_TO_TEAM_ROOM` messages. Bot messages are ignored so the two bridges cannot loop.

The Slack-side bridge uses the ChatGPT bot token for channel history access, but imported messages preserve Nassim as Product Owner in the Team Room record.

Important conclusions reached through casual Slack conversation must be promoted into the appropriate GitHub artifact: finding, test idea, process decision, task, lease, PR comment, architecture/security contract or durable lesson.

## Safety and anti-chaos

- Slack never overrides reviewer independence or exact-SHA review requirements.
- Slack messages do not create implementation authority by themselves; role leases remain governed by GitHub protocols.
- One canonical implementation stream and one implementer remain mandatory.
- Do not mirror secrets, credentials, raw patient data or other prohibited sensitive material.
- Humor is welcome; harassment, patient jokes and fabricated engineering claims are not.
- If Slack is unavailable, GitHub Team Room remains fully functional and authoritative.
