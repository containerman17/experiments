# ACP Mux

A multiplexing relay protocol built on top of [ACP (Agent Client Protocol)](https://github.com/agentclientprotocol/typescript-sdk).

## Problem

ACP is designed for direct client-agent communication over stdio. This doesn't work for:
- **Remote/non-interactive clients** (browsers, phones)
- **Clients that disconnect and reconnect** (device switching, network drops)
- **Multiple agent processes** managed from a single client connection

## What ACP Mux Is

A WebSocket relay server that sits between remote thin clients and ACP agent processes.

```
Browser/Phone ──WebSocket──► ACP Mux Server ──stdio──► ACP Agent Process 1
                                              ──stdio──► ACP Agent Process 2
                                              ──stdio──► ACP Agent Process 3
```

Key principles:
- **ACP messages are relayed transparently** — the Mux does not modify ACP messages. Any ACP-compliant agent works behind it.
- **Built on ACP, not a fork** — embraceable by the ACP community. The Mux is a layer on top, not a competing spec.
- **Clients can disconnect and reconnect** — the Mux buffers all messages with sequence numbers and replays missed ones on reconnect.
- **Multiple clients can observe the same process** — the Mux has "multiple exits."
- **Agents keep running when no client is connected** — work continues in the background.

## Protocol Design

The Mux protocol wraps ACP with a thin management layer. Two categories of commands:

### Machine-level (no processId)

- **`fs/list`** — Browse directories on the host filesystem. This is a Mux-level feature (not ACP) because file listing is about the host machine, not any particular agent session. Clients use this to pick a working folder before spawning an agent.
- **`process/spawn`** — Start a new ACP agent process with a given `cwd` and agent type.
- **`process/list`** — List running agent processes.

### Process-level (requires processId)

- **`process/attach`** — Subscribe to a process's message stream. Accepts a `lastSeenSeq` for catch-up replay of missed messages.
- **`process/detach`** — Stop receiving updates. The process keeps running.
- **`process/kill`** — Terminate a process.
- **Relayed ACP messages** — Everything else is wrapped with `processId` and forwarded to/from the agent's stdio.

### Relayed message format

```json
{ "processId": "abc", "message": { "jsonrpc": "2.0", "method": "session/prompt", ... } }
```

## Typical Flow

1. Client connects via WebSocket
2. `fs/list { path: "/" }` → browse the host filesystem
3. `fs/list { path: "/home/user/projects" }` → find the right folder
4. `process/spawn { cwd: "/home/user/projects/my-app", agent: "claude-code" }` → get `processId`
5. `process/attach { processId, lastSeenSeq: 0 }` → start receiving updates
6. Relay ACP messages: `initialize`, `session/new`, `session/prompt`, etc.
7. Client disconnects (closes laptop, switches device)
8. Agent keeps working — Mux buffers all messages
9. Client reconnects from phone, `process/attach { processId, lastSeenSeq: 42 }` → catches up
10. Continue the conversation

## Permissions

ACP Mux does not strip out permission requests. The `session/request_permission` flow is relayed to the client as-is. For isolated/sandboxed environments, users are encouraged to auto-approve on the client side — but that's the client's choice, not the Mux's.

## Architecture

The Mux server plays two roles:
- **ACP client** to each agent process (speaks full ACP over stdio)
- **Mux protocol server** to browser clients (speaks circuit protocol over WebSocket)

## Tech

- TypeScript
- ACP TypeScript SDK as dependency
- WebSocket server (e.g., `ws`)
- Agent processes spawned as subprocesses
