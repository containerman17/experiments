# TeleClaude

Telegram bot that controls Claude via the Claude Agent SDK.

## Architecture

- Multiple bot instances, each running its own Claude agent
- Environment variables parsed by prefix: `TELEGRAM_BOT_TOKEN_*`
  - e.g. `TELEGRAM_BOT_TOKEN_personal`, `TELEGRAM_BOT_TOKEN_work`
  - Everything after the prefix is just a unique identifier, doesn't matter what
  - Each token spawns its own independent bot + Claude agent
- If no tokens found in env, exit immediately

## Stack

- TypeScript
- Bun runtime (not Node.js)
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- Telegram library: TBD (pick most mature, simple, well-maintained option)

## Telegram formatting

- Telegram does NOT support standard markdown
- Telegram MarkdownV2 requires escaping: `_ * [ ] ( ) ~ ` > # + - = | { } . !`
- No support for: headers, tables, lists, images, horizontal rules
- Best approach: convert Claude output to Telegram HTML mode (`<b>`, `<i>`, `<code>`, `<pre>`, `<a>`)
