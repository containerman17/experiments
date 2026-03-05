# Agent Remote UI — Ideas & Decisions

## What is this?

An AI-first, view-only IDE for managing coding agents on remote servers. Not a code editor — a code *reviewer*. The human's job is review, not editing. Deployed as static files (Cloudflare etc.), connects to servers via WebSocket.

Inspiration: Zed IDE's minimalism — lightweight, no bloat, Windows 7 → Linux feel. Anti-VS Code.

## Hierarchy

- **Servers** — remote machines (VMs), each isolated but internally shared filesystem/network
- **Workspaces** — a folder path on a server (unique by path). Workspace = folder.
- **Tabs** — within a workspace:
  - **Agent chats** (building now) — ACP protocol, supports Claude Code and OpenAI Codex
  - **Terminals** (later) — full PTY via xterm.js

## Architecture

- **Frontend**: React + Vite + Tailwind. No CSS. React Router for URL-based workspace navigation. Clean, simple design.
- **Backend**: TypeScript/Node.js. `ws` for WebSocket, `node-pty` for terminals (later), `child_process` for ACP agent subprocesses.
- **Connection**: Single WebSocket per server, multiplexed by `tabId` and message `type`.
- **State**: All state lives on the server. UI is stateless — fetches everything over WebSocket.

## WebSocket Protocol

Single connection per server. All messages are JSON with `type` and `tabId` routing:

```json
{"type": "agent", "tabId": "agent-1", "acp": {"jsonrpc": "2.0", ...}}
{"type": "terminal", "tabId": "term-1", "data": "<base64>"}
{"type": "terminal.input", "tabId": "term-1", "data": "ls -la\n"}
{"type": "workspace.list", ...}
{"type": "agent.create", "workspacePath": "/home/user/project", ...}
```

## UI Layout

- **Top bar**: server dropdown (+ add server) → workspace dropdown. No project name in UI — goes in browser/native window title.
- **Horizontal tabs** along the top for open items (agent chats, files, terminals) — like browser tabs
- **Left icon rail** (~40px, thin): icons at bottom toggle left drawer panel — git status, file tree, agent history. Zed-style.
- **Left drawer panel** (~250px): slides in/out, not permanent. Shows context based on selected icon.
- **Right sidebar** (~200-250px): contextual, appears only for agent chat tabs. Shows touched files + agent plan + agent config. Disappears for file/terminal tabs.
- **Main content area**: takes all remaining space
- **Mouse-first**: everything clickable, minimal hotkey reliance
- **Desktop-first** (web), mobile-friendly v1, separate mobile layout v2

## Agent Chat UI

- **Show everything**: all tool calls, plans, thinking blocks, diffs — full verbosity
- **Diffs truncated** to ~20 lines with click-to-expand
- **Agent-flavored styling**: Claude look for Claude Code, Codex look for Codex
- **Real text input**: proper textarea with selection, copy/paste, cursor, multiline — not terminal input
- **Permissions**: all auto-granted, no prompts
- **Right sidebar context** (for agent tabs only):
  - Touched files list (per-session filenames, clickable → opens git diff tab)
  - Agent plan (task items with pending/in_progress/completed status)
  - Agent config (model, mode)

## File Viewer / Editor

- **Default**: git diff view (read-only, merged style — additions green, removals red)
- **Edit mode**: click "Edit" button → switches to plain editable file (no diff)
- **Editing**: basic multi-line editing — select, type, delete, paste. No autocomplete, no LSP, no AI.
- **Editor lib**: CodeMirror 6 (lightweight, modular, ~30KB minimal) for both modes — read-only with diff decorations, toggle to editable
- Syntax highlighting (basic, like Notepad++) — tree-sitter WASM in worker thread for large files
- No error squiggles, no intellisense
- File browser: popup/modal to navigate full workspace file tree
- **Future idea (not v1)**: skinny inline chat at bottom of file viewer — sees current text selection, spawns a one-off agent edit (no follow-ups). Like Cursor's inline edit but lighter.

## Tech Stack (decisions in progress)

- **Frontend framework**: choosing between Solid.js (fastest, signals, fine-grained reactivity) and React (ecosystem, AI knowledge base). Leaning Solid.
- **Bundler**: Vite
- **Styling**: Tailwind only, no CSS
- **Editor component**: CodeMirror 6
- **Syntax highlighting**: tree-sitter compiled to WASM (in web worker)
- **Virtualization**: for large files/diffs/chat history — only render visible DOM nodes
- **Terminal (later)**: xterm.js
- **Backend**: TypeScript/Node.js
- **Native apps (later)**: Tauri v2 wrapping the web app

## Agent Behavior

- Full ACP support (file read/write, terminal, tool calls, plans, etc.)
- All permissions auto-granted — no permission prompts. Environment is isolated (VM-level).
- Agents share filesystem and network within the VM.
- Users can create/delete agent sessions.

## Terminal (deferred)

- Full PTY + xterm.js (not text-only)
- Raw byte streaming over WebSocket (base64 encoded)
- Keyboard passthrough, ANSI escape codes, colors, clearing all supported
- Backend: node-pty per terminal session
