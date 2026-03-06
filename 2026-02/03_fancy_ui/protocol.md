# Agent UI — WebSocket Protocol

All communication between the frontend (React/iOS) and backend (Node.js) happens over a single WebSocket connection. Every message is JSON with a `type` field.

The backend also acts as a tunnel to ACP agent processes (Claude Code, Codex, Gemini CLI), which speak JSON-RPC 2.0 over stdio. ACP messages are wrapped inside `agent.message` (client→server) and `agent.output` (server→client).

See [ACP_spec.md](./ACP_spec.md) for the full ACP protocol specification.

---

## Connection Lifecycle

1. **Connect** to `ws://<host>:8080` (configurable). No authentication or handshake — just open the WebSocket.
2. **On open**, the frontend should:
   - Send `workspace.list` to get available workspaces.
   - If navigating to a specific workspace, send `agent.list` with the folder path. The backend responds with `agent.list.result` **and** `tabs.state`, and auto-subscribes the client to all agents in that folder.
3. **On disconnect**, clear all local state. The backend will re-send everything on reconnect.
4. **Auto-reconnect** after 2 seconds on connection loss. On reconnect, repeat step 2.

### Subscription Model

- **Agent subscriptions**: Calling `agent.list` subscribes the client to all agents in that folder. After that, the client receives `agent.output`, `agent.error`, and `agent.exited` for all agents in the folder.
- **Terminal subscriptions**: Calling `terminal.attach` subscribes the client to a specific terminal's output. The backend replays the terminal's ring buffer immediately, then streams live output.
- **Broadcast semantics**: `tabs.state` is broadcast to ALL connected clients. Agent and terminal messages are broadcast only to subscribed clients.

---

## Client → Server

### Workspace

| Type | Payload | Description |
|------|---------|-------------|
| `workspace.list` | *(none)* | Request list of configured workspaces |

### Agent Management

| Type | Payload | Description |
|------|---------|-------------|
| `agent.create` | `{ folder, agentType: 'claude'\|'codex'\|'gemini' }` | Spawn a new agent process |
| `agent.list` | `{ folder }` | List agents for a folder. Also triggers: sends back `tabs.state`, auto-subscribes client to all agents in the folder, and sends `agent.history.result` for each agent |
| `agent.delete` | `{ agentId }` | Kill and archive an agent |
| `agent.message` | `{ agentId, payload }` | Forward a raw ACP JSON-RPC message to agent stdin. **Auto-revives dead agents**: if the agent process has exited, the backend respawns it, re-initializes ACP, restores the session, and then delivers the message |
| `agent.history` | `{ agentId, before?, limit? }` | Load paginated message history from SQLite. `before` is an entry ID for cursor-based pagination, `limit` defaults to 200 |
| `agent.audio` | `{ agentId, data, mimeType }` | Send base64-encoded audio for server-side transcription (Gemini API). Response arrives as `agent.audio.transcription` |

### Terminal Management

| Type | Payload | Description |
|------|---------|-------------|
| `terminal.create` | `{ folder }` | Create a new tmux-backed terminal. Backend responds with `terminal.created` and automatically adds a tab via `tabs.state` |
| `terminal.list` | `{ folder }` | List live terminals for a folder |
| `terminal.attach` | `{ terminalId }` | Subscribe to terminal output. Backend replays ring buffer immediately as `terminal.output` messages |
| `terminal.input` | `{ terminalId, data }` | Write raw string data to terminal stdin (e.g. keystrokes, `"\t"` for tab) |
| `terminal.resize` | `{ terminalId, cols, rows }` | Resize terminal pty + tmux window. Send on attach, on container resize, on visibility change, and on font size change |
| `terminal.close` | `{ terminalId }` | Kill terminal and its tmux session |

### Tab State

| Type | Payload | Description |
|------|---------|-------------|
| `tabs.update` | `{ folder, tabs: TabInfo[], activeTabId: string\|null }` | Persist tab layout. Backend compares with previous tabs and auto-kills agents/terminals that were removed. Broadcasts `tabs.state` to all clients |

### Config

| Type | Payload | Description |
|------|---------|-------------|
| `config.set_preference` | `{ agentType: 'claude'\|'codex'\|'gemini', configId, value }` | Persist a per-agent-type preference to SQLite. Special `configId: '__mode__'` stores the preferred mode. These preferences are restored on agent spawn/revive |

---

## Server → Client

### Workspace

| Type | Payload | Description |
|------|---------|-------------|
| `workspace.list.result` | `{ workspaces: WorkspaceInfo[] }` | Response to `workspace.list` |

### Agent

| Type | Payload | Description |
|------|---------|-------------|
| `agent.list.result` | `{ folder, agents: AgentInfo[] }` | Full agent list for a folder. Each agent includes persisted `acpState` (modes, config, capabilities) |
| `agent.output` | `{ agentId, payload, direction?: 'in'\|'out' }` | ACP JSON-RPC message. `direction: 'out'` (default/omitted) = agent→backend, `direction: 'in'` = echoed client→agent message. **All ACP traffic in both directions is forwarded**, so clients see the full conversation |
| `agent.error` | `{ agentId, message }` | Agent stderr output or spawn failure |
| `agent.exited` | `{ agentId, exitCode }` | Agent process died. Frontend should show error state but NOT remove the agent — it can be auto-revived on next `agent.message` |
| `agent.history.result` | `{ agentId, entries: AgentLogEntry[], hasMore }` | Paginated history response. Entries are ordered oldest→newest. Prepend to local log. `hasMore` indicates more pages available |
| `agent.audio.transcription` | `{ agentId, text }` | Transcription result. Frontend should auto-send the text as a `session/prompt` if non-empty |

### Terminal

| Type | Payload | Description |
|------|---------|-------------|
| `terminal.list.result` | `{ folder, terminals: TerminalInfo[] }` | Response to `terminal.list` |
| `terminal.created` | `{ terminalId }` | Confirmation after `terminal.create`. The tab is auto-added via a `tabs.state` broadcast, so the frontend mainly uses this to know the terminal ID |
| `terminal.output` | `{ terminalId, data }` | Base64-encoded terminal output bytes. Decode with base64→binary→Uint8Array and write to terminal emulator |
| `terminal.exited` | `{ terminalId, exitCode }` | Shell process exited |

### Tab State

| Type | Payload | Description |
|------|---------|-------------|
| `tabs.state` | `{ folder, tabs: TabInfo[], activeTabId: string\|null }` | Authoritative tab list, broadcast to ALL clients after any mutation (create, delete, reorder, tab switch). Frontend should replace its entire tab state with this |

### Errors

| Type | Payload | Description |
|------|---------|-------------|
| `error` | `{ message }` | Generic backend error (unicast to the requesting client) |

---

## ACP Messages (inside `agent.message` / `agent.output`)

The `payload` field in `agent.message` and `agent.output` carries raw ACP JSON-RPC 2.0 objects. The frontend constructs these using helper functions and sends them via `agent.message`. All agent responses and notifications arrive as `agent.output`.

### JSON-RPC 2.0 Basics

Every ACP message has `jsonrpc: "2.0"` and one of:
- **Request**: `{ jsonrpc, id: number, method: string, params: object }` — expects a response with matching `id`
- **Notification**: `{ jsonrpc, method: string, params: object }` — no `id`, no response expected
- **Response**: `{ jsonrpc, id: number, result?: any, error?: { code, message, data? } }` — no `method`

The frontend must track request IDs to correlate responses (e.g., to know which method a response belongs to).

### Messages Sent by Frontend → Agent

#### `session/prompt` (request)

Send a user message to the agent. This starts a prompt turn.

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123",
    "prompt": [
      { "type": "image", "data": "<base64>", "mimeType": "image/png" },
      { "type": "text", "text": "What do you see?" }
    ]
  }
}
```

- `prompt` is an array of content blocks. Text block should be last.
- Images are optional. Include `data` (base64) and `mimeType`.
- Response arrives as a JSON-RPC response with `result.stopReason`.

#### `session/cancel` (notification)

Cancel an in-progress prompt. No response — the pending `session/prompt` response will arrive with `stopReason: "cancelled"`.

```json
{ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": "sess_abc123" } }
```

#### `session/set_mode` (request)

Switch the agent's operating mode.

```json
{ "jsonrpc": "2.0", "id": 2, "method": "session/set_mode", "params": { "sessionId": "sess_abc123", "modeId": "architect" } }
```

Response may include `result.currentModeId` (Claude) or be empty `{}` (Gemini). Track the outgoing `modeId` to handle sparse responses.

#### `session/set_config_option` (request)

Change a config option (model, thinking level, etc.).

```json
{ "jsonrpc": "2.0", "id": 3, "method": "session/set_config_option", "params": { "sessionId": "sess_abc123", "configId": "model", "value": "opus" } }
```

Response may include `result.configOptions` with the full updated config state.

### Messages Sent Automatically by Backend → Agent

These are **not** initiated by the frontend — the backend handles them on spawn/revive:

| ACP Method | When | Description |
|------------|------|-------------|
| `initialize` | On spawn | Negotiate capabilities and protocol version |
| `session/new` | After initialize (new agent) | Create ACP session with working directory |
| `session/load` | After initialize (revived agent) | Resume previous session if agent supports `loadSession`. Agent replays conversation via `session/update` notifications |
| `session/set_mode` | On revive | Restore saved mode preference (from `config.set_preference` with `configId: '__mode__'`) |
| `session/set_config_option` | On revive | Restore all saved config preferences for this agent type |

### Permission Auto-Grant

When the agent sends a `session/request_permission` request, the backend auto-grants it and forwards the message to the frontend for display. The backend sends back:

```json
{
  "jsonrpc": "2.0", "id": "<request_id>",
  "result": { "outcome": { "outcome": "selected", "optionId": "<first_option_id>" } }
}
```

The frontend does NOT need to respond to permission requests — the backend handles it. But the frontend sees both the request (as `agent.output` direction `out`) and the grant response (as `agent.output` direction `in`) in the log.

### Messages from Agent → Frontend

All arrive as `agent.output` messages. Parse the `payload` as JSON-RPC:

#### `initialize` response

```json
{ "jsonrpc": "2.0", "id": 1, "result": {
  "protocolVersion": 1,
  "agentInfo": { "name": "claude-code", ... },
  "agentCapabilities": { "loadSession": true, "promptCapabilities": { "image": true } }
} }
```

#### `session/new` response

```json
{ "jsonrpc": "2.0", "id": 2, "result": {
  "sessionId": "sess_abc123",
  "availableModes": [{ "id": "code", "name": "Code", "description": "..." }, ...],
  "currentModeId": "code",
  "configOptions": [{ "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "sonnet", "options": [...] }, ...]
} }
```

**Gemini quirk**: Modes may be nested under `result.modes.availableModes` and `result.modes.currentModeId` instead of flat on `result`.

#### `session/load` response

Same structure as `session/new` response. Agent replays the conversation as `session/update` notifications before sending this response.

#### `session/prompt` response

```json
{ "jsonrpc": "2.0", "id": 5, "result": { "stopReason": "end_turn" } }
```

Stop reasons: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.

#### `session/set_mode` response

```json
{ "jsonrpc": "2.0", "id": 6, "result": { "currentModeId": "architect" } }
```

May be empty `{}` for some agents (Gemini). Use the outgoing request's `modeId` as fallback.

#### `session/set_config_option` response

```json
{ "jsonrpc": "2.0", "id": 7, "result": { "configOptions": [...] } }
```

May include full updated `configOptions` array. Replace local config state if present.

#### `session/update` (notification)

Streaming progress during a prompt turn. The key field is `params.update.sessionUpdate` which discriminates the update type.

#### `current_mode_update` (notification)

Agent autonomously changed mode. Can arrive as a top-level notification OR inside `session/update`.

```json
{ "jsonrpc": "2.0", "method": "current_mode_update", "params": { "modeId": "code", "modeName": "Code" } }
```

#### `config_options_update` (notification)

Agent updated its available config options.

```json
{ "jsonrpc": "2.0", "method": "config_options_update", "params": { "configOptions": [...] } }
```

Replace the local config options state entirely.

#### `session/request_permission` (request from agent)

```json
{
  "jsonrpc": "2.0", "id": 99,
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess_abc123",
    "permissions": [{
      "toolCall": { "title": "Edit file", "kind": "edit", ... },
      "options": [{ "optionId": "allow", "name": "Allow" }, { "optionId": "reject", "name": "Reject" }]
    }]
  }
}
```

The backend auto-grants these. The frontend sees them in the log for display purposes only.

### `session/update` Variants

The `params.update.sessionUpdate` field discriminates the update type:

#### `agent_message_chunk`

Streaming assistant text.

```json
{ "params": { "update": {
  "sessionUpdate": "agent_message_chunk",
  "content": { "type": "text", "text": "Here is my response..." }
} } }
```

Accumulate text chunks into a single assistant message until the next non-text event.

#### `agent_thought_chunk`

Streaming reasoning/thought text (extended thinking). Render as collapsible "thoughts".

```json
{ "params": { "update": {
  "sessionUpdate": "agent_thought_chunk",
  "content": { "text": "Let me think about..." }
} } }
```

#### `tool_call`

New tool invocation.

```json
{ "params": { "update": {
  "sessionUpdate": "tool_call",
  "toolCallId": "tc_123",
  "title": "Read file: src/main.ts",
  "kind": "read",
  "status": "in_progress",
  "locations": [{ "path": "/path/to/file", "line": 42 }],
  "content": [
    { "type": "text", "text": "file contents..." },
    { "type": "diff", "path": "/path/to/file", "patch": "--- a/file\n+++ b/file\n@@ ...", "before": "...", "after": "..." }
  ]
} } }
```

- `kind`: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other`
- `status`: `pending`, `in_progress`, `completed`, `failed`
- `content` array may contain text blocks, diff blocks, or terminal embeds
- `locations` array indicates affected files (for follow-along UX)

#### `tool_call_update`

Incremental status update for a prior tool call. Match by `toolCallId`.

```json
{ "params": { "update": {
  "sessionUpdate": "tool_call_update",
  "toolCallId": "tc_123",
  "status": "completed"
} } }
```

#### `plan`

Full plan replacement. Each update contains the complete plan — replace, don't merge.

```json
{ "params": { "update": {
  "sessionUpdate": "plan",
  "entries": [
    { "content": "Read codebase", "priority": "high", "status": "completed" },
    { "content": "Implement feature", "priority": "high", "status": "in_progress" },
    { "content": "Write tests", "priority": "medium", "status": "pending" }
  ]
} } }
```

#### `current_mode_update`

Mode change emitted as a session update (in addition to being a top-level notification).

```json
{ "params": { "update": {
  "sessionUpdate": "current_mode_update",
  "modeId": "code",
  "modeName": "Code"
} } }
```

#### `available_commands_update`

Slash commands advertised by the agent. Not currently rendered by the web frontend but should be implemented in iOS.

```json
{ "params": { "update": {
  "sessionUpdate": "available_commands_update",
  "commands": [{ "name": "web", "description": "Search the web", "input": { "hint": "search query" } }]
} } }
```

Slash commands are invoked by sending a regular `session/prompt` with the text starting with `/` (e.g. `/web search query`).

#### `usage_update`

Token usage statistics. Not currently rendered.

```json
{ "params": { "update": {
  "sessionUpdate": "usage_update",
  "usage": { ... }
} } }
```

---

## Frontend State Derivation

The frontend stores raw ACP log entries and derives UI state from them. Here's how:

### Session ID

Extract from the first `agent.output` (direction `out`) that is a JSON-RPC response with `result.sessionId`. This comes from the `session/new` or `session/load` response. The agent is not interactive until you have a session ID.

### Busy State

Set `busy = true` when sending `session/prompt`. Set `busy = false` when receiving a response with `result.stopReason`. Also set `busy = false` on `agent.exited`.

### Modes & Config Options

1. Start with `agent.info.acpState` from `agent.list.result` (persisted server-side, survives page refresh).
2. Update from `session/new` or `session/load` response.
3. Apply `current_mode_update` notifications.
4. Apply `config_options_update` notifications.
5. Apply `session/set_mode` and `session/set_config_option` responses (match by JSON-RPC ID).

### Chat Message Accumulation

Process the log sequentially to build a list of chat messages:

1. **User messages**: `direction: 'in'` entries with `method: 'session/prompt'`. Extract text and images from `params.prompt[]`.
2. **Agent text**: `session/update` with `agent_message_chunk`. Accumulate consecutive chunks.
3. **Agent thoughts**: `session/update` with `agent_thought_chunk`. Accumulate consecutive chunks. Render as collapsible.
4. **Tool calls**: `session/update` with `tool_call`. Apply `tool_call_update` to matching `toolCallId`. Group consecutive tool calls into collapsible groups.
5. **Plans**: `session/update` with `plan`. Replace previous plan.
6. **Mode changes**: `current_mode_update` (both top-level and inside session/update).
7. **Prompt completion**: Response with `stopReason` — flush pending text/thought buffers.

Skip all other messages (initialize, session/new, permission grants, etc.) — they're infrastructure.

---

## Key Data Types

### WorkspaceInfo
```typescript
{ folder: string, agentCount: number }
```

### AgentInfo
```typescript
{
  id: string,
  folder: string,
  agentType: 'claude' | 'codex' | 'gemini',
  createdAt: number,  // Unix timestamp ms
  sessionId?: string, // ACP session ID if agent has been initialized
  acpState?: AgentAcpState
}
```

### AgentAcpState
```typescript
{
  modes: Array<{ id: string, name: string, description?: string }>,
  currentModeId: string,
  configOptions: Array<{
    id: string,
    name: string,
    description?: string,
    category?: string,  // 'mode' | 'model' | 'thought_level' | custom
    type: string,       // currently only 'select'
    currentValue: string,
    options: Array<{ name: string, value?: string, description?: string }>
  }>,
  promptCapabilities?: { audio?: boolean },
  loadSession?: boolean
}
```

### TabInfo
```typescript
{
  kind: 'agent' | 'terminal',
  id: string,       // unique tab ID
  label: string,    // display name
  agentId?: string,    // set when kind='agent'
  terminalId?: string  // set when kind='terminal'
}
```

### AgentLogEntry
```typescript
{
  id: number,
  agentId: string,
  direction: 'in' | 'out',  // 'in' = client→agent, 'out' = agent→client
  payload: object,           // raw JSON-RPC message
  timestamp: number          // Unix timestamp ms
}
```

### TerminalInfo
```typescript
{
  id: string,
  folder: string,
  cols: number,      // current column count
  rows: number,      // current row count
  createdAt: number  // Unix timestamp ms
}
```

---

## Typical Flows

### App Startup
```
Client                          Server
  |-- ws connect ----------------->|
  |-- workspace.list ------------->|
  |<-- workspace.list.result ------|
  |   (user picks a workspace)
  |-- agent.list { folder } ------>|
  |<-- tabs.state { folder, ... }--|
  |<-- agent.list.result ----------|
  |<-- agent.history.result -------|  (one per agent)
  |<-- agent.output (live) --------|  (ongoing)
```

### Creating an Agent
```
Client                          Server                    Agent Process
  |-- agent.create --------------->|
  |                                |-- spawn process ------->|
  |                                |-- initialize ---------->|
  |<-- agent.output (init req) ----|                         |
  |                                |<-- init response -------|
  |<-- agent.output (init resp) ---|                         |
  |                                |-- session/new --------->|
  |<-- agent.output (new req) -----|                         |
  |                                |<-- session/new resp ----|
  |<-- agent.output (new resp) ----|                         |
  |<-- agent.list.result ----------|  (updated list)
  |<-- tabs.state -----------------|  (new tab added)
```

### Sending a Message
```
Client                          Server                    Agent Process
  |-- agent.message { payload } -->|
  |<-- agent.output (dir:'in') ----|-- payload to stdin ---->|
  |                                |<-- session/update ------|  (streaming)
  |<-- agent.output (update) ------|                         |
  |<-- agent.output (update) ------|  ... more chunks ...    |
  |                                |<-- prompt response -----|
  |<-- agent.output (response) ----|                         |
```

### Auto-Revive Dead Agent
```
Client                          Server                    Agent Process
  |-- agent.message { payload } -->|
  |   (agent is dead)              |
  |                                |-- respawn ------------->|
  |                                |-- initialize ---------->|
  |                                |<-- init response -------|
  |                                |-- session/load -------->|
  |                                |<-- load response -------|
  |                                |-- set_mode (restore) -->|
  |                                |-- set_config (restore)->|
  |                                |-- payload to stdin ---->|
  |<-- agent.output (all above) ---|                         |
```

### Terminal Session
```
Client                          Server
  |-- terminal.create ------------>|
  |<-- terminal.created -----------|
  |<-- tabs.state -----------------|
  |-- terminal.attach ------------>|
  |<-- terminal.output (buffer) ---|  (ring buffer replay)
  |-- terminal.resize ------------>|
  |-- terminal.input { data } ---->|
  |<-- terminal.output ------------|  (live output, base64)
```
