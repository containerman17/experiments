# Telegram ACP Bot

Simple Telegram bot for controlling Claude Code agents on the go via ACP (Agent Client Protocol).

## Prior Art

- **2026-02/01_teleclaude** — Telegram bot with forum-based multi-topic Claude sessions. This prototype borrows the Telegram integration patterns (grammy, voice transcription via Gemini, markdown-to-HTML conversion, message splitting) but simplifies to single-user single-thread.
- **2026-02/03_fancy_ui** — Full ACP client with React frontend. This prototype borrows the ACP protocol understanding (JSON-RPC over stdio, session lifecycle, `stopReason` completion signal) but uses the simpler CLI stream-json interface rather than raw ACP.

## Design Principles

- **Single user, single thread** — one active agent session at a time
- **Ephemeral processes** — spawn agent on message, kill after response completes
- **Auto-detach** — no manual `/stop` needed; `stopReason` from ACP ends the turn
- **Voice-first** — voice messages are the primary input method on mobile

## Architecture

```
User (Telegram) → Bot → spawn claude process → ACP over stdio → kill on done
```

No long-lived agent processes. Each interaction cycle:
1. User sends message (text or voice)
2. Bot spawns Claude CLI with `--input-format stream-json --output-format stream-json`
3. If resuming: uses `--resume <sessionId>` to load session
4. Sends user message via stdin
5. Reads streaming NDJSON responses from stdout
6. On `type: "result"` → sends final response to Telegram, kills process
7. Bot is now detached — next message without active session gets a prompt to `/resume`

## State

All state lives in a single YAML config file (no database). Persisted:
- `token`: Telegram bot token
- `gemini_api_key`: for voice transcription
- `user_id`: authorized user's Telegram ID (single user)
- `active_session`: currently attached session ID (null when detached)
- `sessions`: map of session ID → { name, directory, last_messages[] }

`last_messages` (last 3 text messages, both user and assistant) serves two purposes:
- Recap on `/resume` — show context before you start talking
- Voice transcription context — Gemini uses these to disambiguate technical terms

**Important:** `directory` must be stored per session and passed correctly on resume.
Claude Code does not support resuming conversations from a wrong folder.

## Commands

| Command | Description |
|---------|-------------|
| `/resume` | List recent sessions as inline buttons, tap to attach |
| `/new <directory>` | Start a new session in given directory |

No `/stop` — auto-detach after every agent response.

## Flow

### `/resume`
1. List last 5 sessions as inline keyboard buttons (name + short ID)
2. User taps one → bot sends last 2-3 messages as recap
3. Session is now active — next text/voice goes to this agent

### Sending a message
1. Check if there's an active session → if not, reply "No active session. Use /resume"
2. Spawn Claude process with `--resume <sessionId>`
3. Send user message to stdin
4. Stream `session/update` notifications → forward text to Telegram
5. On `type: "result"` → show "Done (Xs)" message, kill process, auto-detach

### Voice message
1. Download OGG from Telegram
2. Send to Gemini for transcription with last 3 messages as context
3. Reply with transcription text
4. Treat as regular text message (send to agent)

## Stack

- TypeScript + Bun runtime
- grammy (Telegram bot framework)
- Claude CLI with stream-json I/O (same as teleclaude)
- Gemini API for voice transcription
- js-yaml for config persistence

## Config Example

```yaml
token: "telegram-bot-token"
gemini_api_key: "gemini-key"
gemini_model: "gemini-3.1-pro-preview"
user_id: 123456789
active_session: null
sessions:
  sess_abc123:
    name: "experiments"
    directory: "/home/user/experiments"
    last_messages:
      - "I've updated the config parser to handle the new format."
      - "Tests are passing now."
```
