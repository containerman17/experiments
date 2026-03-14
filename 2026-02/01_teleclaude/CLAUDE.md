# TeleClaude

Telegram bot that controls Claude via the Claude Agent SDK.

## Architecture

- Single bot instance connecting to Claude via `query()` from `@anthropic-ai/claude-agent-sdk`
- Each Telegram group/chat the bot is added to is a separate logical "instance" with its own conversation
- Chat ID → group mapping stored in `config.yaml` under `groups`
- `/resume` lists recent sessions with inline buttons, creates group config on selection
- No topics support — one group = one bot conversation
- Auth via `allowed_users` list in config (Telegram user IDs)

## Config (config.yaml)

```yaml
token: TELEGRAM_BOT_TOKEN
gemini_api_key: GEMINI_KEY
gemini_model: gemini-3-flash-preview
allowed_users:
  - 12345678
groups:
  "chat_id":
    directory: /path/to/working/dir
    session_id: uuid  # auto-managed
```

## Stack

- TypeScript
- Bun runtime (not Node.js)
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) — legacy `query()` API, not v2
- Grammy for Telegram
- sharp for SVG→PNG rendering (code blocks, tables)

## Message rendering pipeline

All Claude output goes through `sendResponse()` which:
1. Parses markdown into segments: text, code blocks, tables
2. Text → converted to Telegram HTML (`<b>`, `<i>`, `<code>`, `<a>`)
3. Code blocks → rendered as PNG images (dark theme, line numbers, max 100 lines)
4. Tables → rendered as PNG images (light theme, grid, bold headers)
5. Font: DejaVu Sans Mono, bundled in `fonts/` and embedded as base64 in SVGs

## Commands

- `/new` — start fresh conversation (keep directory)
- `/resume` — list last 10 sessions with inline buttons to resume
- `/stop` — abort current response
