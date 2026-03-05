# Frontend — Plan

> **NOTE**: Do NOT use plan mode. Implement directly.
> **NOTE**: NEVER start the dev server. The user runs it in their own ecosystem.

## Philosophy

No SPA routing. Normal page navigation with full reloads.
URL path = workspace folder (e.g. `example.com/home/ubuntu/myproject`).
Root `/` = home page with workspace list.
Frontend parses raw ACP JSON-RPC from `agent.output` messages — backend is just a tunnel.

## Stack

- React 19 + Vite + Tailwind v4
- No react-router (just `window.location.pathname`)
- No CSS files — Tailwind only
- xterm.js for terminal

## Pages

### Home (`/`)
- Fetches `workspace.list` from backend → shows list of folders with agent counts
- Freestyle text input for entering a folder path (later: file browser)
- Click workspace or submit path → navigates to `/<folder-path>`

### Workspace (`/<folder-path>`)
- Left: agent list + "Create Agent" button
- Center: active agent chat OR terminal
- Right: agent config sidebar (plan, touched files, mode, config options)
- Tabs for switching between agents and terminals

## ACP Message Handling

Frontend sends raw JSON-RPC wrapped in `agent.message`. Receives raw JSON-RPC via `agent.output`.

### Lifecycle (frontend drives):
1. On agent.create → backend spawns process, frontend sends `initialize` then `session/new`
2. User types message → frontend sends `session/prompt`
3. Agent streams `session/update` notifications → frontend renders incrementally
4. Agent may send `session/request_permission` → frontend auto-grants (for now)
5. Prompt turn ends when `session/prompt` response arrives with StopReason

### ACP messages frontend must SEND (via agent.message):
- `initialize` — on agent create
- `session/new` — after initialize response
- `session/prompt` — user message
- `session/cancel` — stop button
- `session/set_mode` — mode dropdown change
- `session/set_config_option` — config dropdown change

### ACP messages frontend must HANDLE (from agent.output):
- `initialize` response — extract agent info/capabilities
- `session/new` response — extract sessionId, modes, configOptions
- `session/update` notification — render text, tool calls, plan, thinking
- `session/prompt` response — stop reason, turn complete
- `session/request_permission` — auto-grant for now
- `available_commands_update` notification — slash command list
- `current_mode_update` notification — mode changed by agent
- `config_options_update` notification — config changed by agent
- `fs/read_text_file` request — respond with file content (later)
- `fs/write_text_file` request — respond with success (later)

## Files

| File | Purpose |
|------|---------|
| `main.tsx` | React root mount |
| `App.tsx` | Route by pathname: home vs workspace |
| `ws.ts` | WebSocket connection singleton with send/subscribe |
| `acp.ts` | ACP JSON-RPC helpers: build messages, parse notifications, ID generation |
| `store.ts` | React context + reducer for app state |
| `pages/HomePage.tsx` | Workspace list + folder input |
| `pages/WorkspacePage.tsx` | Layout shell for a workspace |
| `components/AgentList.tsx` | Sidebar agent list + create button |
| `components/AgentChat.tsx` | Chat messages, tool calls, thinking, diffs, input |
| `components/AgentSidebar.tsx` | Plan, touched files, mode, config options |
| `components/TabBar.tsx` | Horizontal tabs (agents + terminals) |
| `components/Terminal.tsx` | xterm.js PTY terminal |

## Implementation Order

- [x] Rewrite plan.md
- [x] ws.ts — WebSocket singleton (auto-connect, reconnect, send/subscribe)
- [x] acp.ts — JSON-RPC helpers (request/notification/response builders, ACP request factories)
- [x] store.ts — new state: AgentState with raw log, ACP lifecycle flags, tabs
- [x] App.tsx — pathname routing (no react-router), WS→store bridge
- [x] pages/HomePage.tsx — workspace list from backend, folder text input, full-page navigation
- [x] pages/WorkspacePage.tsx — layout: agent list | chat/terminal | sidebar
- [x] components/AgentList.tsx — agent list, create Claude/Codex, open terminal
- [x] components/AgentChat.tsx — ACP lifecycle (initialize→session/new→prompt), render session/update, auto-grant permissions, stop button
- [x] components/AgentSidebar.tsx — plan, modes, config options parsed from ACP log
- [x] components/TabBar.tsx — agent + terminal tabs with close
- [x] components/Terminal.tsx — xterm.js + FitAddon + WebLinksAddon, PTY over WS
- [x] Build passes (TypeScript clean)
- [x] Removed react-router-dom dependency

## TODO (not implementing now)

- [ ] Respond to `fs/read_text_file` requests from agent (need file access)
- [ ] Respond to `fs/write_text_file` requests from agent
- [ ] Respond to `terminal/*` requests from agent (agent-initiated terminals)
- [ ] File browser for folder selection (replace text input)
- [ ] Markdown rendering in agent messages
- [ ] Syntax highlighting in diffs (CodeMirror)
- [ ] Mobile layout
