# Frontend — Plan

> **NOTE**: Do NOT use plan mode. Implement directly.
> **NOTE**: NEVER start the dev server. The user runs it in their own ecosystem.

## Philosophy

This is an **agent control panel**, not an IDE. The user directs agents and observes what's happening. No code editing here (yet — code review/reading later).

No SPA routing. Normal page navigation with full reloads.
URL path = workspace folder (e.g. `example.com/home/ubuntu/myproject`).
Root `/` = home page with workspace list.

The frontend is purely an **observer + optional override**. Agents work independently on the backend. The frontend renders what it sees and sends user input. If disconnected, agents keep working. On reconnect, user gets full history replay.

## Key Architectural Decision: Two Kinds of Terminals

- **User terminals**: persistent PTY shells for poking around. Bottom panel or tabs. User creates, attaches, detaches. Survive reconnects via ring buffer replay.
- **Agent terminals**: commands the agent is running (ACP `terminal/create`). Rendered **inline in tool call cards** in the chat. User can see live output and kill them. These are handled entirely by the backend — frontend just observes.

## Stack

- React 19 + Vite + Tailwind v4
- No react-router (just `window.location.pathname`)
- xterm.js for user terminals

## Pages

### Home (`/`)
- Workspace list from `workspace.list`
- Folder text input (later: file browser)
- Server URL editor with green/red connection indicator

### Workspace (`/<folder-path>`)
- Left: agent list + terminal list + create buttons
- Center: active agent chat OR user terminal
- Right: agent sidebar (plan, modes, config, delete)
- Tab bar for switching

## ACP Message Handling

Frontend sends raw JSON-RPC via `agent.message`. Receives via `agent.output`.

### Lifecycle (frontend drives):
1. `agent.create` → backend spawns process
2. Frontend sends `initialize` then `session/new`
3. User types → `session/prompt`
4. Agent streams `session/update` → render incrementally
5. `session/request_permission` → backend auto-grants (later: frontend can override)
6. Turn ends with `session/prompt` response (StopReason)

### Messages frontend renders from agent.output:
- `session/update` — text, tool calls (with inline agent terminal output), plan, thinking
- `session/prompt` response — stop reason
- `available_commands_update` — slash commands
- `current_mode_update` / `config_options_update` — sidebar updates

### Messages backend handles (NOT frontend):
- `terminal/*` — backend executes, responds to agent, broadcasts output
- `fs/*` — backend reads/writes files, responds to agent
- `session/request_permission` — backend auto-grants (frontend can override later)

## Files

| File | Purpose |
|------|---------|
| `main.tsx` | React root mount |
| `App.tsx` | Route by pathname, WS→store bridge |
| `ws.ts` | WebSocket singleton (auto-connect, reconnect, status callbacks) |
| `acp.ts` | ACP JSON-RPC helpers |
| `store.ts` | React context + reducer |
| `pages/HomePage.tsx` | Workspace list, folder input, server URL |
| `pages/WorkspacePage.tsx` | Layout shell |
| `components/AgentList.tsx` | Agent + terminal list, create buttons |
| `components/AgentChat.tsx` | Chat, tool calls, thinking, diffs |
| `components/AgentSidebar.tsx` | Plan, modes, config, delete |
| `components/TabBar.tsx` | Tabs (agents + terminals) |
| `components/Terminal.tsx` | xterm.js user terminal with attach/detach |

## Done

- [x] WebSocket singleton with status, reconnect, editable URL
- [x] ACP JSON-RPC helpers
- [x] Store with agent state, terminal list, tabs
- [x] Pathname routing, WS→store bridge
- [x] Home page with workspace list + server indicator
- [x] Workspace page with agent list, chat, sidebar, tabs
- [x] Agent chat with full ACP lifecycle
- [x] Agent sidebar with plan, modes, config, delete (with confirm)
- [x] User terminals: persistent, attachable, ring buffer replay
- [x] Terminal list in sidebar for reattach
- [x] Agent error display (stderr forwarding)
- [x] Build passes, no react-router

## Next

- [ ] Agent terminal output inline in tool call cards (once backend intercepts `terminal/*`)
- [ ] Bottom panel layout for user terminals (separate from agent chat tabs)
- [ ] Slash command autocomplete (from `available_commands_update`)

## Later

- [ ] Code viewer (read-only, for reviewing agent output)
- [ ] File browser for folder selection
- [ ] Markdown rendering in agent messages
- [ ] Syntax highlighting in diffs
- [ ] Permission override UI (approve/deny from frontend)
- [ ] Mobile layout
