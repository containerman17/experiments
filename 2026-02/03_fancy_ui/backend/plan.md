# Backend — Plan

> **NOTE**: Do NOT use plan mode. Implement directly.
> **NOTE**: NEVER start the backend server. The user runs it in their own ecosystem.

## Philosophy

The backend is the **ACP client**. It handles all ACP client responsibilities so agents never depend on a connected frontend. The frontend is purely an observer + optional override.

## Three Roles

1. **ACP client** — intercept `terminal/*`, `fs/*`, `session/request_permission` from agent stdout. Execute locally, respond to agent stdin. Auto-grant permissions by default.
2. **Logger** — everything goes to SQLite (raw tunnel messages + intercepted ones).
3. **Broadcaster** — forward everything to connected frontends for observation. If no frontend is connected, agents keep working.

## Architecture

```
Frontend (WS) ←→ Backend ←→ Agent process (stdio, JSON-RPC)
  (observer)      ↕   ↕
               SQLite  Local filesystem + PTYs
```

The backend reads agent stdout, and for most messages just logs + broadcasts (tunnel mode). But for `terminal/*`, `fs/*`, and `session/request_permission` requests, it intercepts, handles them locally, and responds back to the agent.

## Two Kinds of Terminals

- **User terminals**: persistent PTY shells, opened by user, survive reconnects. Managed via `terminal.create/list/attach/close` WebSocket messages. Ring buffer for replay.
- **Agent terminals**: spawned by the agent via ACP `terminal/create` requests. The backend executes these, responds to the agent, and broadcasts live output to frontends. Frontend renders them inline in tool call cards. User can kill them.

## Entities

- **Agent** = an ACP process (claude/codex CLI) spawned in a folder
  - SQLite: id, folder, agent_type, created_at, archived (soft delete)
- **Workspace** = virtual, `SELECT DISTINCT folder FROM agents WHERE archived = 0`
- **User Terminal** = a persistent PTY process, in-memory with ring buffer
- **Agent Terminal** = a command execution spawned by the agent via ACP, in-memory

## WebSocket Protocol

### Client → Server (frontend → backend)

| Message | Description |
|---------|-------------|
| `workspace.list` | list distinct folders with active agents |
| `agent.create {folder, agentType}` | spawn ACP process |
| `agent.list {folder}` | list non-archived agents in folder |
| `agent.delete {agentId}` | kill + archive |
| `agent.message {agentId, payload}` | pipe raw JSON-RPC to agent stdin |
| `agent.history {agentId, before?, limit}` | paginated log |
| `terminal.create {folder}` | spawn user PTY |
| `terminal.list {folder}` | list alive user terminals |
| `terminal.attach {terminalId}` | subscribe + replay ring buffer |
| `terminal.input {terminalId, data}` | write to user PTY |
| `terminal.resize {terminalId, cols, rows}` | resize user PTY |
| `terminal.close {terminalId}` | kill user PTY |

### Server → Client (backend → frontend)

| Message | Description |
|---------|-------------|
| `workspace.list.result` | list of {folder, agentCount} |
| `agent.list.result` | agents in folder |
| `agent.output {agentId, payload}` | raw JSON-RPC from agent, forwarded |
| `agent.error {agentId, message}` | stderr from agent process |
| `agent.exited {agentId, exitCode}` | agent process died |
| `agent.history.result` | paginated log entries |
| `terminal.list.result` | alive user terminals in folder |
| `terminal.created {terminalId}` | user PTY ready |
| `terminal.output {terminalId, data}` | user PTY output (base64) |
| `terminal.exited {terminalId, exitCode}` | user PTY died |
| `error {message}` | generic error |

## SQLite Schema

```sql
agents (id, folder, agent_type, created_at, archived DEFAULT 0)
agent_log (id, agent_id, direction, payload, timestamp)
```

## Files

| File | Role | Status |
|------|------|--------|
| `index.ts` | WS server entry point | done |
| `db.ts` | SQLite queries | done |
| `ws-handler.ts` | WebSocket message routing | done |
| `agent-manager.ts` | spawn agents, pipe stdio, log, broadcast | done |
| `terminal-manager.ts` | persistent user PTYs with ring buffer + multi-subscriber | done |

## Done

- [x] Slim tunnel protocol (shared/types.ts)
- [x] SQLite with soft delete + paginated history
- [x] Agent process manager with stdio piping
- [x] WebSocket message routing
- [x] stderr forwarding as agent.error
- [x] Persistent user terminals with ring buffer + attach/detach
- [x] Terminal list/attach for reconnect

## Next: ACP Client (intercept agent requests)

- [ ] Intercept `terminal/create` from agent stdout — spawn command, respond with terminal ID
- [ ] Handle `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`
- [ ] Broadcast agent terminal output to frontends (new message type: `agent.terminal.output`)
- [ ] Intercept `fs/read_text_file` — read file, respond
- [ ] Intercept `fs/write_text_file` — write file, respond
- [ ] Intercept `session/request_permission` — auto-grant (later: forward to frontend for user decision)

## Later

- [ ] Frontend-controlled permission decisions (deny/allow from UI)
- [ ] File explorer endpoints
- [ ] Git integration
- [ ] Graceful shutdown
- [ ] Agent process health monitoring
