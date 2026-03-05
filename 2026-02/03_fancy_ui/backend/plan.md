# Backend — Plan

> **NOTE**: Do NOT use plan mode. Implement directly.
> **NOTE**: NEVER start the backend server. The user runs it in their own ecosystem.

## Philosophy

The backend is a **logging tunnel + process manager**. It does NOT interpret ACP messages.
Frontend is the smart one — it reads raw ACP JSON-RPC and renders UI from it.

## Architecture

```
Frontend (WS) ←→ Backend (WS server) ←→ Agent process (stdio, JSON-RPC)
                        ↕
                  SQLite (log all messages)
```

## Entities

- **Agent** = an ACP process (claude/codex CLI) spawned in a folder
  - SQLite: id, folder, agent_type, created_at, archived (soft delete)
- **Workspace** = virtual, NOT a real entity
  - Just `SELECT DISTINCT folder FROM agents WHERE archived = 0`
- **Terminal** = a PTY process, independent of agents

## WebSocket Protocol

### Client → Server

| Message | Description |
|---------|-------------|
| `workspace.list` | list distinct folders with active agents |
| `agent.create {folder, agentType}` | spawn ACP process, insert row, return updated agent list |
| `agent.list {folder}` | list all non-archived agents in folder |
| `agent.delete {agentId}` | kill process, set `archived=1`, return updated list |
| `agent.message {agentId, payload}` | pipe raw JSON-RPC to agent stdin, log to SQLite |
| `agent.history {agentId, before?, limit=50}` | return last N logged messages, paginated backward |
| `terminal.create {folder}` | spawn PTY |
| `terminal.input {terminalId, data}` | write to PTY |
| `terminal.resize {terminalId, cols, rows}` | resize PTY |
| `terminal.close {terminalId}` | kill PTY |

### Server → Client

| Message | Description |
|---------|-------------|
| `workspace.list.result {folders}` | list of {folder, agentCount} |
| `agent.list.result {folder, agents}` | agents in folder |
| `agent.output {agentId, payload}` | raw JSON-RPC from agent stdout, forwarded as-is |
| `agent.exited {agentId, exitCode}` | agent process died |
| `agent.history.result {agentId, messages, hasMore}` | paginated log |
| `terminal.created {terminalId}` | PTY ready |
| `terminal.output {terminalId, data}` | PTY output (base64) |
| `terminal.exited {terminalId, exitCode}` | PTY died |
| `error {message}` | generic error |

## SQLite Schema

```sql
agents (id, folder, agent_type, created_at, archived DEFAULT 0)
agent_log (id, agent_id, direction, payload, timestamp)  -- direction: 'in' or 'out'
```

No more: sessions, messages, touched_files, config.json workspace list.

## Files

| File | Role | Status |
|------|------|--------|
| `index.ts` | WS server entry point | keep, simplify |
| `db.ts` | SQLite setup + queries | rewrite (new schema) |
| `ws-handler.ts` | message routing | rewrite (new protocol) |
| `agent-manager.ts` | spawn/kill ACP processes, pipe stdio | rewrite from scratch |
| `terminal-manager.ts` | PTY spawn/IO/resize | keep as-is |
| `config.ts` | was for config.json workspace list | delete (workspaces from DB now) |
| `workspace-manager.ts` | file tree, file read/write, git diff | delete (not needed now) |

## Implementation Order

- [x] Write new plan.md
- [x] Rewrite shared/types.ts — new slim protocol (AgentInfo, WorkspaceInfo, AgentLogEntry, 10 client msgs, 9 server msgs)
- [x] Rewrite db.ts — agents + agent_log tables, soft delete, paginated history
- [x] Rewrite agent-manager.ts — spawn ACP process, pipe newline-delimited JSON-RPC via stdio, log to SQLite, broadcast to WS subscribers
- [x] Rewrite ws-handler.ts — new message routing (workspace.list, agent.create/list/delete/message/history, terminal.*)
- [x] Simplify index.ts — just WS server + port
- [x] Delete config.ts and workspace-manager.ts
- [x] Test: server starts, workspace.list returns empty list

## Later (not now)

- [ ] File explorer (file.tree, file.read endpoints)
- [ ] Git integration (git.diff, git status watch)
- [ ] Graceful shutdown (SIGTERM handler)
- [ ] Agent process health monitoring
