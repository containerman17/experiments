# Agent Client Protocol (ACP) Specification

> Source: [agentclientprotocol.com](https://agentclientprotocol.com) — Apache 2.0 License
> Originally created by [Zed Industries](https://zed.dev/acp), co-developed with Google and JetBrains.

## Overview

ACP standardizes communication between **code editors** (Clients) and **coding agents** (Agents) using **JSON-RPC 2.0** over **newline-delimited stdio**. It reuses MCP (Model Context Protocol) JSON representations where possible and adds custom types for agentic coding UX (diffs, terminals, plans). Default text format is Markdown.

### Terminology

- **Client**: An IDE/editor (Zed, Neovim, JetBrains, etc.) that provides the user interface
- **Agent**: A program using generative AI to autonomously modify code (Claude Code, Codex CLI, Gemini CLI, etc.)

---

## Transport

### stdio (required)

- Client launches agent as a subprocess
- Agent reads JSON-RPC from **stdin**, writes to **stdout**
- Messages delimited by `\n`, **MUST NOT** contain embedded newlines
- Agent **MUST NOT** write non-ACP content to stdout
- Logging goes to **stderr**
- All messages **MUST** be UTF-8 encoded

### Streamable HTTP (draft)

- For remote agents — communicating over HTTP or WebSocket
- Still under active discussion / work-in-progress

---

## Message Types

- **Methods**: Request-response (expects result or error)
- **Notifications**: One-way, no response expected

---

## Protocol Phases

### Phase 1: Initialization

Client calls `initialize` with:
- Protocol version (single integer, incremented only for breaking changes)
- Client capabilities
- Client info (name, title, version)

Agent responds with:
- Supported protocol version (or its own latest if mismatch)
- Agent capabilities
- Agent info

**Client Capabilities:**
- `readTextFile`: boolean — can the client read files for the agent?
- `writeTextFile`: boolean — can the client write files for the agent?
- `terminal`: boolean — can the client execute shell commands?

**Agent Capabilities:**
- `loadSession`: boolean — can resume previous sessions
- `promptCapabilities`: image, audio, embedded context support
- `mcpCapabilities`: HTTP, SSE, stdio MCP server support
- `sessionCapabilities`: extended session features

### Phase 2: Session Setup

#### Create Session — `session/new`

Parameters:
- Working directory (absolute path, serves as filesystem boundary)
- MCP server connection details

Response includes:
- Unique session ID (e.g., `"sess_abc123def456"`)
- `currentModeId` and `availableModes` array
- `configOptions` array

#### Load Session — `session/load` (optional)

- Requires `loadSession` capability
- Parameters: session ID, MCP servers, working directory
- Agent **MUST** replay entire conversation via `session/update` notifications

### Phase 3: Prompt Turn

A prompt turn is one complete interaction cycle:

1. **Client sends** `session/prompt` with user message + resources (text, images, files)
2. **Agent processes** via LLM — may produce text, tool calls, or both
3. **Agent streams** `session/update` notifications with progress (text chunks, tool calls, plan updates, thoughts)
4. **Tool execution** — agent may request permission via `session/request_permission` before executing
5. **Tool results** feed back to LLM, cycle repeats
6. **Completion** — agent responds to original `session/prompt` with a `StopReason`

**Stop Reasons:** `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`

**Cancellation:** Client sends `session/cancel` → agent stops ASAP, returns `cancelled` stop reason.

---

## Session Modes

Modes allow agents to operate in different configurations, affecting system prompts, tool availability, and permission requirements.

### Available Modes (examples)

| Mode ID | Name | Description |
|---------|------|-------------|
| `ask` | Ask | Request permission before making any changes |
| `architect` | Architect | Design and plan software systems without implementation |
| `code` | Code | Write and modify code with full tool access |

### Mode Changes

- **Client-initiated:** `session/set_mode` with `sessionId` and `modeId`
- **Agent-initiated:** Agent sends `current_mode_update` notification

### Plan Mode Exit Pattern

A common workflow for "plan" or "architect" modes:
1. Agent designs a solution in plan mode
2. Agent provides a special tool allowing LLM to request mode switch
3. Client presents options: auto-accept all actions / manually accept each / reject
4. On approval, mode switches and client is notified via `current_mode_update`

---

## Session Config Options

Agents can expose customizable settings during a session.

**ConfigOption structure:**
- `id`, `name`, `description`
- `category`: `mode`, `model`, `thought_level`, or custom (`_`-prefixed)
- `type`: currently only `select`
- `currentValue`, `options[]` (each with name + description)

**Changes:**
- Client → Agent: `session/set_config_option`
- Agent → Client: `config_options_update` notification

Both return complete current config state.

---

## File System Access

Agents must check client capabilities before using these methods.

### Read — `fs/read_text_file`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionId` | yes | Session identifier |
| `path` | yes | Absolute file path |
| `line` | no | Starting line (1-based) |
| `limit` | no | Max lines to read |

Returns: `{ content: string }`

### Write — `fs/write_text_file`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionId` | yes | Session identifier |
| `path` | yes | Absolute file path |
| `content` | yes | Text to write |

Returns: `null` on success. Client creates file if non-existent.

---

## Terminal Access

Requires `terminal: true` in client capabilities.

### Methods

| Method | Description |
|--------|-------------|
| `terminal/create` | Launch command with args, env, cwd, output limits. Returns terminal ID. |
| `terminal/output` | Get current output (non-blocking). Returns text + truncation status. |
| `terminal/wait_for_exit` | Block until command completes. Returns exit code + signal. |
| `terminal/kill` | Terminate running command. Terminal remains valid. |
| `terminal/release` | Kill command + free resources. Terminal ID invalidated. |

Agents **MUST** always call `terminal/release` when done.

Terminals can be embedded in tool call content for live output display.

**Timeout pattern:** create → race timer vs `wait_for_exit` → `kill` on timeout → get output → `release`.

---

## Tool Calls

Reported via `session/update` notifications.

### Tool Call Structure

- `toolCallId`: unique identifier
- `title`: human-readable description
- `kind`: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other`
- `status`: `pending` → `in_progress` → `completed` | `failed`
- `locations`: affected files with optional line numbers (for follow-along UX)

### Content Types

- **Regular content**: text, images, resource blocks
- **Diffs**: file modifications with before/after + absolute paths
- **Terminals**: embedded live terminal output

### Permissions

Agent may call `session/request_permission` before executing sensitive tools. Client presents options (e.g., "Allow once", "Reject"). Outcomes: `cancelled` or `selected`.

---

## Agent Plan

Agents communicate multi-step execution strategies via `session/update`.

**Plan Entry:**
- `content`: human-readable task description
- `priority`: `high`, `medium`, `low`
- `status`: `pending`, `in_progress`, `completed`

Agent **MUST** send complete plan list in each update. Client replaces entire plan on each update. Plans can evolve dynamically.

---

## Slash Commands

Agents advertise commands via `available_commands_update` notification.

**Command structure:**
- `name`: command identifier (e.g., "web", "test")
- `description`: what it does
- `input` (optional): text input spec with hint

Invoked via regular `session/prompt` with slash prefix (e.g., `/web search query`). Commands can be dynamically added/removed during a session.

---

## Extensibility

- **`_meta` field**: Present on all types for custom metadata. Reserved keys: `traceparent`, `tracestate`, `baggage` (W3C/OpenTelemetry).
- **Extension methods**: Prefixed with `_`. Follow JSON-RPC 2.0 semantics. Unknown requests → "Method not found" error. Unknown notifications → silently ignored.
- Custom fields **MUST NOT** be added directly to type definitions.

---

## Schema Summary — All Methods

### Agent Methods (client → agent)

| Method | Required | Description |
|--------|----------|-------------|
| `initialize` | yes | Negotiate capabilities and protocol version |
| `authenticate` | yes | Handle client authentication |
| `session/new` | yes | Create a new session |
| `session/load` | no | Resume a previous session |
| `session/prompt` | yes | Send user message, start prompt turn |
| `session/cancel` | yes | Cancel current prompt turn *(notification, no response)* |
| `session/set_config_option` | no | Change a config option |
| `session/set_mode` | no | Switch session mode |

### Client Methods (agent → client)

| Method | Required | Description |
|--------|----------|-------------|
| `session/request_permission` | yes | Ask user for permission |
| `session/update` | yes | Stream progress notifications |
| `fs/read_text_file` | no | Read a file |
| `fs/write_text_file` | no | Write/create a file |
| `terminal/create` | no | Launch a shell command |
| `terminal/output` | no | Get terminal output |
| `terminal/wait_for_exit` | no | Wait for command completion |
| `terminal/kill` | no | Kill running command |
| `terminal/release` | no | Free terminal resources |
