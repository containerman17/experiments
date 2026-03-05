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

Tab-centric layout. No permanent left sidebar.

- **Tab bar** (top): all open agents + terminals in one row. Left side: tabs. Right side: [+Agent] [+Terminal] buttons + connection dot (green/red).
- **[+Agent]** opens a popup (not a tab) — choose claude/codex or resurrect an archived agent. On confirm, spawns agent and opens its tab.
- **[+Terminal]** creates a new PTY and opens its tab immediately.
- **Content area**: active tab fills the space. Chat content has max-width (~prose width). Terminals are full-width.
- **Agent sidebar** (right): plan, modes, config, delete — only visible when an agent tab is active.
- **Disconnected overlay**: grey semi-transparent overlay over everything when WS is disconnected.
- **document.title** = folder name (last path segment).
- Tabs are renameable (double-click label to edit, later).
- Split view (2-way, slot-based) designed from ground up but single slot first.

### Tab State: Backend-Owned, Multi-Device

Tabs are persisted on the backend (per workspace). The backend is the single source of truth. Frontend on connect receives `tabs.state` with the full tab list + active tab. Any user action (open/close/switch/rename tab) sends `tabs.update` → backend stores + broadcasts `tabs.state` to all connected clients. Last write wins, no conflict resolution needed — only conscious user actions trigger updates, so no circular loops.

This gives real multi-device experience: close laptop lid, open iPad, see the same tabs and active view. Terminals and agent chats are multiplexed — multiple devices see the same live output simultaneously (already works via broadcast).

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
| `components/NewAgentDialog.tsx` | Popup: choose agent type or resurrect archived |
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

## Next: Layout Restructure

- [ ] Remove AgentList sidebar — replace with tab bar [+Agent] [+Terminal] buttons
- [ ] New agent popup (NewAgentDialog) — choose type or resurrect archived
- [ ] Tab bar: connection dot, all tabs in one row
- [ ] Grey overlay when disconnected
- [ ] document.title = folder name
- [ ] Max-width on chat content, full-width on terminals
- [ ] Agent terminal output inline in tool call cards (once backend intercepts `terminal/*`)
- [ ] Slash command autocomplete (from `available_commands_update`)

## Soon: Agent Resurrection via session/resume

ACP supports `session/resume {sessionId}` — spawn a fresh process, send `initialize` then `session/resume` instead of `session/new`. The agent picks up where it left off. Session IDs are already logged in SQLite. Close tab = kill process (cheap). Reopen = spawn + resume. Need: list archived agents in NewAgentDialog, let user pick one to resurrect.

## Later

- [ ] Code viewer (read-only, for reviewing agent output)
- [ ] File browser for folder selection
- [ ] Markdown rendering in agent messages
- [ ] Syntax highlighting in diffs
- [ ] Permission override UI (approve/deny from frontend)
- [ ] Mobile layout
