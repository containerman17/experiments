# Architecture

## Stack

```
Browser (static, Cloudflare Pages)
  ↓ wss:// (via Cloudflare Tunnel)
Server (Node.js + TypeScript on VM)
  ↓ stdio (JSON-RPC / ACP)
Agent processes (claude-code, codex CLI)
```

## Frontend → Backend Connection

- Single WebSocket per server, multiplexed by `type` + `tabId`
- Frontend stores server URLs in localStorage (manual input for now)
- No auth for v1 — Cloudflare Tunnel provides the secure transport
- Future: forward proxy with Google/GitHub OAuth, pre-authed bash one-liner to add servers

## SSL / Tunneling

- **Dev**: `cloudflared tunnel --url http://localhost:8080` (no account, random URL)
- **Prod**: Cloudflare Tunnel with fixed domain + Cloudflare Access (Google/GitHub auth)
- Server never opens ports — tunnel punches outbound

## Agent Auth

- Agents are pre-authenticated on the server (user runs `claude login` / `codex auth` manually via SSH)
- Server just spawns agent processes which use existing credentials
- We are a UI proxy, not an auth proxy

## Persistence — SQLite

All ACP messages persisted to SQLite (`better-sqlite3`) for history replay on page refresh.

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  agent_type TEXT NOT NULL,  -- 'claude' | 'codex'
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'stopped' | 'crashed'
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  direction TEXT NOT NULL,  -- 'client_to_agent' | 'agent_to_client'
  acp_message TEXT NOT NULL,  -- JSON
  timestamp INTEGER NOT NULL
);

CREATE TABLE touched_files (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  file_path TEXT NOT NULL,
  first_touched INTEGER NOT NULL,
  UNIQUE(session_id, file_path)
);
```

On WebSocket connect → client requests sessions for a workspace → server replays from SQLite.

## Backend Modules

```
server/
├── index.ts              -- Entry point, WebSocket server (ws)
├── ws-handler.ts         -- Auth middleware, message routing
├── workspace-manager.ts  -- Maps folder paths → workspace state
├── agent-manager.ts      -- Spawns ACP agents, bridges stdio ↔ WS
├── acp-client.ts         -- ACP protocol implementation (JSON-RPC over stdio)
├── db.ts                 -- SQLite (better-sqlite3) setup + queries
└── config.ts             -- Server config (~/.agent-ui/config.json)
```

## ACP Client Behavior

Our server acts as an ACP **client** (agents are ACP servers):

1. Spawn agent process → `initialize` handshake
2. `session/new` with workspace path
3. Forward user prompts via `session/prompt`
4. Stream `session/update` notifications to frontend via WebSocket
5. Auto-grant all `session/request_permission` requests
6. Handle `fs/read_text_file` / `fs/write_text_file` — read/write files on behalf of agent
7. Handle `terminal/*` — spawn and manage terminals on behalf of agent
8. Persist all messages to SQLite

## WebSocket Protocol (UI ↔ Server)

```jsonc
// Client → Server
{"type": "workspace.list"}
{"type": "workspace.sessions", "workspacePath": "/home/user/project"}
{"type": "agent.create", "workspacePath": "/home/user/project", "agentType": "claude"}
{"type": "agent.prompt", "sessionId": "sess_abc", "text": "add auth middleware"}
{"type": "agent.cancel", "sessionId": "sess_abc"}
{"type": "agent.delete", "sessionId": "sess_abc"}
{"type": "file.read", "workspacePath": "/home/user/project", "path": "src/main.ts"}
{"type": "file.write", "workspacePath": "/home/user/project", "path": "src/main.ts", "content": "..."}
{"type": "file.tree", "workspacePath": "/home/user/project"}
{"type": "git.diff", "workspacePath": "/home/user/project", "path": "src/main.ts"}

// Server → Client
{"type": "workspace.list.result", "workspaces": [...]}
{"type": "workspace.sessions.result", "sessions": [...]}
{"type": "agent.created", "sessionId": "sess_abc", "agentType": "claude"}
{"type": "agent.update", "sessionId": "sess_abc", "acp": {...}}
{"type": "agent.stopped", "sessionId": "sess_abc", "reason": "end_turn"}
{"type": "file.read.result", "content": "...", "path": "..."}
{"type": "file.tree.result", "tree": {...}}
{"type": "git.diff.result", "diff": "...", "path": "..."}
```

## Config

`~/.agent-ui/config.json`:
```json
{
  "workspaces": ["/home/user/project-a", "/home/user/project-b"],
  "port": 8080
}
```

DB stored at `~/.agent-ui/data.db`.
