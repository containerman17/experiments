// Terminal manager: pure tmux-to-websocket bridge.
// tmux is the source of truth — sessions are created externally (bash alias).
// Server discovers sessions via `tmux list-sessions`, attaches via node-pty.
//
// DA escape sequence suppression: same approach as the old project.
// On attach, tmux sends Device Attribute queries that produce artifacts.
// We suppress initial output and send ctrl-L to redraw cleanly.

import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
import type WebSocket from 'ws';
import type { ServerMessage, SessionInfo } from '../frontend/src/types.ts';

const RING_BUFFER_SIZE = 50 * 1024; // 50KB of base64 output
const TMUX_SOCKET = 'claudemux';
const TMUX = `tmux -L ${TMUX_SOCKET}`;

const DA_RESPONSE_RE = /\x1b\[[\?>][\d;]*c/g;

interface LiveSession {
  name: string;
  proc: pty.IPty;
  subscribers: Set<WebSocket>;
  ringBuffer: string[];
  ringSize: number;
  cols: number;
  rows: number;
  exited: boolean;
}

const sessions = new Map<string, LiveSession>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(session: LiveSession, msg: ServerMessage): void {
  for (const ws of session.subscribers) send(ws, msg);
}

function pushToRingBuffer(session: LiveSession, b64: string): void {
  session.ringBuffer.push(b64);
  session.ringSize += b64.length;
  while (session.ringSize > RING_BUFFER_SIZE && session.ringBuffer.length > 1) {
    session.ringSize -= session.ringBuffer.shift()!.length;
  }
}

function attachToTmux(name: string, cols: number, rows: number): pty.IPty {
  return pty.spawn('tmux', ['-L', TMUX_SOCKET, 'attach', '-t', name], {
    name: 'xterm-256color',
    cols,
    rows,
    env: process.env as Record<string, string>,
  });
}

function wireUp(session: LiveSession, suppress = false): void {
  let suppressed = suppress;

  session.proc.onData((data: string) => {
    if (suppressed) {
      suppressed = false;
      try { execSync(`${TMUX} send-keys -t ${session.name} C-l`); } catch { /* ignore */ }
      return;
    }
    const filtered = data.replace(DA_RESPONSE_RE, '');
    if (!filtered) return;
    const b64 = Buffer.from(filtered, 'utf-8').toString('base64');
    pushToRingBuffer(session, b64);
    broadcast(session, { type: 'terminal.output', session: session.name, data: b64 });
  });

  session.proc.onExit(() => {
    // Check if tmux session is still alive
    if (tmuxSessionExists(session.name)) {
      // Detach happened, re-attach
      try {
        session.proc = attachToTmux(session.name, session.cols, session.rows);
        wireUp(session, true);
      } catch {
        markExited(session);
      }
    } else {
      markExited(session);
    }
  });
}

function markExited(session: LiveSession): void {
  session.exited = true;
  broadcast(session, { type: 'terminal.exited', session: session.name });
  setTimeout(() => sessions.delete(session.name), 5000);
}

function tmuxSessionExists(name: string): boolean {
  try {
    execSync(`${TMUX} has-session -t ${name} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

// Discover all sessions on our tmux socket
export function listSessions(): SessionInfo[] {
  try {
    const output = execSync(
      `${TMUX} list-sessions -F '#{session_name}\t#{session_path}\t#{session_created}\t#{window_width}\t#{window_height}\t#{session_attached}' 2>/dev/null`
    ).toString().trim();
    if (!output) return [];
    return output.split('\n').map(line => {
      const [name, path, created, width, height, attached] = line.split('\t');
      return {
        name,
        path,
        created: parseInt(created, 10),
        width: parseInt(width, 10),
        height: parseInt(height, 10),
        attached: attached !== '0',
      };
    });
  } catch {
    return []; // no tmux server running
  }
}

// Ensure we have a live pty attached to a tmux session
function ensureLive(name: string): LiveSession | null {
  const existing = sessions.get(name);
  if (existing && !existing.exited) return existing;

  if (!tmuxSessionExists(name)) return null;

  // Apply desired tmux options on first attach
  try {
    execSync(`${TMUX} set-option -t ${name} mouse on 2>/dev/null`);
    execSync(`${TMUX} set-option -t ${name} set-clipboard on 2>/dev/null`);
    execSync(`${TMUX} set-option -t ${name} history-limit 200000 2>/dev/null`);
    execSync(`${TMUX} set-option -t ${name} status off 2>/dev/null`);
  } catch { /* ignore */ }

  const cols = 80;
  const rows = 24;
  const proc = attachToTmux(name, cols, rows);

  const session: LiveSession = {
    name,
    proc,
    subscribers: new Set(),
    ringBuffer: [],
    ringSize: 0,
    cols,
    rows,
    exited: false,
  };

  // Capture current pane content for ring buffer
  try {
    const content = execSync(`${TMUX} capture-pane -t ${name} -p`).toString();
    if (content.trim()) {
      const b64 = Buffer.from(content, 'utf-8').toString('base64');
      pushToRingBuffer(session, b64);
    }
  } catch { /* ignore */ }

  wireUp(session, true);
  sessions.set(name, session);
  return session;
}

export function attach(ws: WebSocket, sessionName: string): boolean {
  const session = ensureLive(sessionName);
  if (!session) return false;

  session.subscribers.add(ws);

  // Replay ring buffer
  for (const b64 of session.ringBuffer) {
    send(ws, { type: 'terminal.output', session: sessionName, data: b64 });
  }

  if (session.exited) {
    send(ws, { type: 'terminal.exited', session: sessionName });
  }

  return true;
}

export function detach(ws: WebSocket, sessionName: string): void {
  sessions.get(sessionName)?.subscribers.delete(ws);
}

export function detachAll(ws: WebSocket): void {
  for (const session of sessions.values()) {
    session.subscribers.delete(ws);
  }
}

export function write(sessionName: string, data: string): void {
  const s = sessions.get(sessionName);
  if (s && !s.exited) s.proc.write(data);
}

export function sendKeys(sessionName: string, keys: string): void {
  try {
    execSync(`${TMUX} send-keys -t ${sessionName} ${keys}`);
  } catch { /* ignore */ }
}

export function scroll(sessionName: string, lines: number): void {
  try {
    if (lines < 0) {
      // Scroll up: enter copy mode, then move up
      execSync(`${TMUX} copy-mode -t ${sessionName}`);
      execSync(`${TMUX} send-keys -t ${sessionName} -N ${Math.abs(lines)} C-y`);
    } else {
      // Scroll down
      execSync(`${TMUX} send-keys -t ${sessionName} -N ${lines} C-e`);
    }
  } catch { /* ignore */ }
}

export function resize(sessionName: string, cols: number, rows: number): void {
  const s = sessions.get(sessionName);
  if (s && !s.exited) {
    s.proc.resize(cols, rows);
    s.cols = cols;
    s.rows = rows;
    try {
      execSync(`${TMUX} resize-window -t ${sessionName} -x ${cols} -y ${rows}`);
    } catch { /* ignore */ }
  }
}

// Get plain text from ring buffer for voice transcription context.
// Decodes base64 chunks, strips ANSI escape sequences, returns last ~4KB of text.
export function getContext(sessionName: string): string {
  const s = sessions.get(sessionName);
  if (!s) return '';
  const raw = s.ringBuffer.map(b64 => Buffer.from(b64, 'base64').toString('utf-8')).join('');
  // Strip ANSI escapes
  const plain = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  // Return last ~4KB
  return plain.slice(-4096);
}

export function closeAll(): void {
  for (const s of sessions.values()) {
    if (!s.exited) s.proc.kill();
  }
  sessions.clear();
}
