// Terminal manager: tmux-backed persistent terminals with multi-subscriber broadcasting.
// Terminals survive both frontend reconnects AND server restarts (tmux sessions persist).
// Each terminal keeps a ring buffer (~50KB) of recent output for replay on attach.
// Multiple WS connections can subscribe to the same terminal simultaneously.
//
// HACK: DA escape sequence suppression
// When node-pty attaches to a tmux session, tmux sends Device Attribute (DA) queries
// that produce artifacts like "1;2c" or "0;276;0c" in the terminal output. These are
// escape sequences (\e[?1;2c, \e[>0;276;0c) that get split across chunks, making them
// impossible to fully filter with regex alone. To work around this, we suppress all
// output for ~100ms after attach, then send ctrl-C + ctrl-L to cancel any partial input
// and redraw the prompt cleanly. See wireUpTerminal() and filterTmuxNoise().

import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { ServerMessage } from '../shared/types.ts';
import { trackTerminal, untrackTerminal, listAllTrackedTerminals } from './db.ts';
import { getTabState } from './tab-store.ts';

const RING_BUFFER_SIZE = 50 * 1024; // 50KB of base64 output
const TMUX_PREFIX = 'agentui_'; // prefix for our tmux sessions
const TMUX_SOCKET = 'agentui';
const TMUX = `tmux -L ${TMUX_SOCKET}`;

export interface TerminalInfo {
  id: string;
  folder: string;
  cols: number;
  rows: number;
  createdAt: number;
}

interface LiveTerminal {
  id: string;
  folder: string;
  proc: pty.IPty;
  subscribers: Set<WebSocket>;
  ringBuffer: string[];
  ringSize: number;
  cols: number;
  rows: number;
  createdAt: number;
  exited: boolean;
  exitCode?: number;
}

const terminals = new Map<string, LiveTerminal>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(term: LiveTerminal, msg: ServerMessage): void {
  for (const ws of term.subscribers) send(ws, msg);
}

function pushToRingBuffer(term: LiveTerminal, b64: string): void {
  term.ringBuffer.push(b64);
  term.ringSize += b64.length;
  while (term.ringSize > RING_BUFFER_SIZE && term.ringBuffer.length > 1) {
    term.ringSize -= term.ringBuffer.shift()!.length;
  }
}

function tmuxSessionName(id: string): string {
  return `${TMUX_PREFIX}${id}`;
}

function tmuxSessionExists(id: string): boolean {
  try {
    execSync(`${TMUX} has-session -t ${tmuxSessionName(id)} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function createTmuxSession(id: string, folder: string, cols: number, rows: number): void {
  const session = tmuxSessionName(id);
  execSync(`${TMUX} new-session -d -s ${session} -x ${cols} -y ${rows} -c ${JSON.stringify(folder)}`);
  // Disable terminal feature detection to prevent DA query artifacts ("1;2c")
  // Safe because this is our own isolated tmux server (via -L socket)
  execSync(`${TMUX} set-option -s terminal-features ''`);
  // Disable status bar so tmux is invisible
  execSync(`${TMUX} set-option -t ${session} status off`);
  // Match xterm.js terminal type
  execSync(`${TMUX} set-option -t ${session} default-terminal xterm-256color`);
  // Disable prefix key so all keypresses pass through to the shell
  execSync(`${TMUX} set-option -t ${session} prefix None`);
  // Set aggressive-resize so it follows our pty size
  execSync(`${TMUX} set-option -t ${session} aggressive-resize on`);
}

function attachToTmuxSession(id: string, cols: number, rows: number): pty.IPty {
  const session = tmuxSessionName(id);
  return pty.spawn('tmux', ['-L', TMUX_SOCKET, 'attach', '-t', session], {
    name: 'xterm-256color',
    cols,
    rows,
    env: process.env as Record<string, string>,
  });
}

// Filter out terminal device attribute responses that tmux emits on attach.
// Full sequences: \e[?1;2c (DA1), \e[>0;276;0c (DA2)
// Partial fragments from chunk splitting: bare "1;2c" or "0;276;0c" at start of data
const DA_RESPONSE_RE = /\x1b\[[\?>][\d;]*c/g;
const DA_FRAGMENT_RE = /^[\d;]+c/;

function filterTmuxNoise(data: string): string {
  return data.replace(DA_RESPONSE_RE, '').replace(DA_FRAGMENT_RE, '');
}

function wireUpTerminal(term: LiveTerminal, suppress = false): void {
  const { id } = term;
  // On attach, tmux emits DA query artifacts. We suppress all output until we get any
  // data from the pty, then send ctrl-L to redraw the prompt cleanly.
  let suppressed = suppress;

  term.proc.onData((data: string) => {
    if (suppressed) {
      suppressed = false;
      try { execSync(`${TMUX} send-keys -t ${tmuxSessionName(id)} C-l`); } catch { /* ignore */ }
      return;
    }
    const filtered = data.replace(DA_RESPONSE_RE, '');
    if (!filtered) return;
    const b64 = Buffer.from(filtered, 'utf-8').toString('base64');
    pushToRingBuffer(term, b64);
    broadcast(term, { type: 'terminal.output', terminalId: id, data: b64 });
  });

  term.proc.onExit(({ exitCode }) => {
    // The pty attach exited. Check if tmux session is still alive (could be server-side detach vs actual exit).
    if (tmuxSessionExists(id)) {
      // tmux session still alive — this was just a detach (shouldn't normally happen). Re-attach.
      try {
        term.proc = attachToTmuxSession(id, term.cols, term.rows);
        wireUpTerminal(term, true);
      } catch {
        term.exited = true;
        term.exitCode = exitCode;
        broadcast(term, { type: 'terminal.exited', terminalId: id, exitCode });
        setTimeout(() => terminals.delete(id), 5000);
      }
    } else {
      // tmux session is gone — shell actually exited
      term.exited = true;
      term.exitCode = exitCode;
      broadcast(term, { type: 'terminal.exited', terminalId: id, exitCode });
      setTimeout(() => terminals.delete(id), 5000);
    }
  });
}

export function createTerminal(folder: string): string {
  const id = `term_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const cols = 80;
  const rows = 24;

  createTmuxSession(id, folder, cols, rows);
  trackTerminal(id, folder);
  const proc = attachToTmuxSession(id, cols, rows);

  const term: LiveTerminal = {
    id,
    folder,
    proc,
    subscribers: new Set(),
    ringBuffer: [],
    ringSize: 0,
    cols,
    rows,
    createdAt: Date.now(),
    exited: false,
  };

  wireUpTerminal(term, true);
  terminals.set(id, term);
  return id;
}

// Re-attach to a tmux session that survived a server restart.
// Returns true if the session was found and re-attached.
export function resurrectTerminal(id: string, folder: string, createdAt: number): boolean {
  if (!tmuxSessionExists(id)) return false;
  if (terminals.has(id)) return true; // already live

  const cols = 80;
  const rows = 24;
  const proc = attachToTmuxSession(id, cols, rows);

  const term: LiveTerminal = {
    id,
    folder,
    proc,
    subscribers: new Set(),
    ringBuffer: [],
    ringSize: 0,
    cols,
    rows,
    createdAt,
    exited: false,
  };

  wireUpTerminal(term, true);
  terminals.set(id, term);

  // Capture visible pane content for ring buffer so attach gets something
  try {
    const content = execSync(`${TMUX} capture-pane -t ${tmuxSessionName(id)} -p`).toString();
    if (content.trim()) {
      const b64 = Buffer.from(content, 'utf-8').toString('base64');
      pushToRingBuffer(term, b64);
    }
  } catch { /* ignore */ }

  return true;
}

export function attachTerminal(ws: WebSocket, terminalId: string): boolean {
  const term = terminals.get(terminalId);
  if (!term) return false;

  term.subscribers.add(ws);

  // Replay ring buffer
  for (const b64 of term.ringBuffer) {
    send(ws, { type: 'terminal.output', terminalId, data: b64 });
  }

  if (term.exited) {
    send(ws, { type: 'terminal.exited', terminalId, exitCode: term.exitCode ?? 1 });
  }

  return true;
}

export function detachTerminal(ws: WebSocket, terminalId: string): void {
  terminals.get(terminalId)?.subscribers.delete(ws);
}

export function detachAll(ws: WebSocket): void {
  for (const term of terminals.values()) {
    term.subscribers.delete(ws);
  }
}

export function writeToTerminal(terminalId: string, data: string): void {
  const t = terminals.get(terminalId);
  if (t && !t.exited) t.proc.write(data);
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): void {
  const t = terminals.get(terminalId);
  if (t && !t.exited) {
    t.proc.resize(cols, rows);
    t.cols = cols;
    t.rows = rows;
    // Also resize the tmux session itself
    try {
      execSync(`${TMUX} resize-window -t ${tmuxSessionName(terminalId)} -x ${cols} -y ${rows}`);
    } catch { /* ignore */ }
  }
}

export function closeTerminal(terminalId: string): void {
  const t = terminals.get(terminalId);
  if (t) {
    if (!t.exited) t.proc.kill();
    terminals.delete(terminalId);
  }
  untrackTerminal(terminalId);
  // Kill the tmux session too
  try {
    execSync(`${TMUX} kill-session -t ${tmuxSessionName(terminalId)} 2>/dev/null`);
  } catch { /* ignore */ }
}

export function listTerminals(folder: string): TerminalInfo[] {
  const result: TerminalInfo[] = [];
  for (const t of terminals.values()) {
    if (t.folder === folder && !t.exited) {
      result.push({ id: t.id, folder: t.folder, cols: t.cols, rows: t.rows, createdAt: t.createdAt });
    }
  }
  return result;
}

export function closeAll(): void {
  for (const t of terminals.values()) {
    if (!t.exited) t.proc.kill();
    // Don't kill tmux sessions on server shutdown — they should persist
  }
  terminals.clear();
}

// On startup: resurrect terminals that have tabs, kill orphans.
export function resurrectAndCleanup(): void {
  const tracked = listAllTrackedTerminals();

  // Collect all terminal IDs referenced by any tab
  const tabbedTerminalIds = new Set<string>();
  // We need to check all folders — get them from tracked terminals
  const folders = new Set(tracked.map(t => t.folder));
  for (const folder of folders) {
    const tabState = getTabState(folder);
    for (const tab of tabState.tabs) {
      if (tab.kind === 'terminal' && tab.terminalId) {
        tabbedTerminalIds.add(tab.terminalId);
      }
    }
  }

  for (const { id, folder, createdAt } of tracked) {
    if (tabbedTerminalIds.has(id)) {
      // Has a tab — try to resurrect
      const ok = resurrectTerminal(id, folder, createdAt);
      if (!ok) {
        // tmux session gone, clean up
        untrackTerminal(id);
      }
    } else {
      // Orphan — no tab references it, kill it
      try {
        execSync(`${TMUX} kill-session -t ${tmuxSessionName(id)} 2>/dev/null`);
      } catch { /* ignore */ }
      untrackTerminal(id);
    }
  }

  // Also kill any tmux sessions with our prefix that aren't in SQLite (extra safety)
  try {
    const output = execSync(`${TMUX} list-sessions -F '#{session_name}' 2>/dev/null`).toString();
    for (const line of output.split('\n')) {
      const name = line.trim();
      if (name.startsWith(TMUX_PREFIX)) {
        const id = name.slice(TMUX_PREFIX.length);
        if (!terminals.has(id)) {
          execSync(`${TMUX} kill-session -t ${name} 2>/dev/null`);
        }
      }
    }
  } catch { /* no tmux server running, fine */ }
}
