# ClaudeMux

Web-based tmux client. Access your terminal sessions from phone or desktop.

## Quick Start

```bash
# 1. Start the backend
cd backend && GEMINI_API_KEY=your-key node index.ts

# 2. Start the frontend (separate terminal)
cd frontend && npx vite

# 3. Create a tmux session
tmux -L claudemux new-session -s myproject -c ~/myproject
```

Open http://localhost:5173 — your session appears automatically.

## Bash Shortcut

Add to `~/.bashrc`:

```bash
cmux() {
  local name="${1:-$(basename "$PWD")}"
  tmux -L claudemux new-session -d -s "$name" -c "$PWD"
  echo "Created session: $name"
}
```

Then: `cmux` to create a session named after the current directory, or `cmux myname` for a custom name.

## Architecture

- **tmux** is the source of truth. Sessions are created externally, the server discovers them.
- **Backend** (`node index.ts`): WebSocket server that bridges tmux sessions to the browser. Polls `tmux list-sessions` every 10s. Handles voice transcription via Gemini.
- **Frontend** (Vite + React + Tailwind): xterm.js terminals with voice input. Desktop has a sidebar, mobile has a bottom toolbar with arrow keys, enter, and voice.
- **Voice**: records audio in browser, sends over WebSocket with session name. Server grabs terminal context from its ring buffer and sends both to Gemini for contextual transcription.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | WebSocket server port |
| `GEMINI_API_KEY` | — | Required for voice transcription |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model to use |
