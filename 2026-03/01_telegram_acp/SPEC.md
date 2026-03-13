# Telegram ACP Bot

Simple Telegram bot for controlling Claude Code agents on the go via ACP (Agent Client Protocol).

## Prior Art

- **2026-02/01_teleclaude** — Telegram bot with forum-based multi-topic Claude sessions. This prototype borrows the Telegram integration patterns (grammy, voice transcription via Gemini, markdown-to-HTML conversion, message splitting) but simplifies to single-user single-thread.
- **2026-02/03_fancy_ui** — Full ACP client with React frontend. This prototype borrows the ACP protocol understanding (JSON-RPC over stdio, session lifecycle, `stopReason` completion signal).

## Design Principles

- **Single user, single thread** — one active agent session at a time
- **Ephemeral processes** — spawn agent on message, kill after response completes
- **Auto-detach** — no manual `/stop` needed; `stopReason` from ACP ends the turn
- **Voice-first** — voice messages are the primary input method on mobile
- **No session registry** — sessions discovered via ACP `session/list`, not tracked in config

## Architecture

```
User (Telegram) → Bot → spawn Claude as ACP agent (stdio) → ACP SDK → kill on done
```

Uses `@agentclientprotocol/sdk` to communicate with Claude Code over ACP (JSON-RPC 2.0 over stdio). No CLI stream-json wrapper — direct ACP protocol.

Each interaction cycle:
1. User sends message (text or voice)
2. Bot spawns Claude CLI as subprocess, wraps stdin/stdout with `acp.ndJsonStream`
3. Creates `ClientSideConnection`, calls `initialize` → `session/resume` → `prompt`
4. Collects `agent_message_chunk` updates via `sessionUpdate` callback
5. On prompt completion (`stopReason`) → sends response to Telegram, kills process
6. Bot is now detached — next message without active session prompts `/resume`

### Session Discovery

Sessions are discovered dynamically via ACP `session/list` (stabilized in SDK v0.16.0). No need to maintain a session registry — the agent knows its own sessions.

- `/resume` spawns a temporary agent, calls `listSessions()`, kills it
- Each `SessionInfo` contains: `sessionId`, `cwd`, `title`, `updatedAt`
- `cwd` from the session is used on resume — solves the "wrong folder" problem

### Session Resume

Uses `session/resume` (unstable) instead of `session/load`. Key difference: `session/resume` restores context without replaying message history, which is faster for our use case.

## State

### Persisted (YAML config)
Only credentials — nothing about sessions:
- `token`: Telegram bot token
- `gemini_api_key`: for voice transcription
- `user_id`: authorized user's Telegram ID (single user)
- `claude_bin`: (optional) path to Claude CLI binary

### In-memory
- `activeSessionId` / `activeSessionCwd`: currently attached session (null when detached)
- `sessionMessages`: last 6 messages per session (3 turns) for:
  - Recap on `/resume` — show context before you start talking
  - Voice transcription context — Gemini uses these to disambiguate technical terms
- These reset on bot restart — that's fine, context rebuilds after first exchange

**Important:** `cwd` must be passed correctly on resume. Claude Code does not support resuming conversations from a wrong folder. The `cwd` comes from `SessionInfo` returned by `session/list`.

## Commands

| Command | Description |
|---------|-------------|
| `/resume` | Discover sessions via ACP, show as inline buttons, tap to attach |
| `/new <directory>` | Create a new session in given directory via `session/new` |

No `/stop` — auto-detach after every agent response.

## Flow

### `/resume`
1. Spawn temporary Claude process, call `session/list`
2. Sort by `updatedAt`, show top 5 as inline keyboard buttons
3. User taps one → set as active, show recap from in-memory messages
4. Next text/voice goes to this agent

### Sending a message
1. Check active session → if none, reply "No active session. Use /resume"
2. Spawn Claude process, `initialize` → `session/resume` → `prompt`
3. Collect `agent_message_chunk` updates → send to Telegram on completion
4. Kill process, clear active session (auto-detach)

### Voice message
1. Download OGG from Telegram
2. Send to Gemini for transcription with last messages as context
3. Reply with transcription text
4. Treat as regular text message (send to agent)

## Stack

- TypeScript + Bun runtime
- `@agentclientprotocol/sdk` — ACP client over stdio
- grammy — Telegram bot framework
- Gemini API — voice transcription
- js-yaml — config file

## Config Example

```yaml
token: "telegram-bot-token"
gemini_api_key: "gemini-key"
gemini_model: "gemini-3.1-pro-preview"
user_id: 123456789
```

That's the entire config. No session tracking needed.
