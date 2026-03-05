// Terminal manager: persistent PTY processes with multi-subscriber broadcasting.
// Terminals survive frontend reconnects and device switches.
// Each terminal keeps a ring buffer (~50KB) of recent output for replay on attach.
// Multiple WS connections can subscribe to the same terminal simultaneously.
// Terminals only die on explicit close or process exit — never on WS disconnect.

import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { ServerMessage } from '../shared/types.ts';

const RING_BUFFER_SIZE = 50 * 1024; // 50KB of base64 output

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
  // Ring buffer: array of base64 chunks, total size tracked
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
  // Trim from front if over limit
  while (term.ringSize > RING_BUFFER_SIZE && term.ringBuffer.length > 1) {
    term.ringSize -= term.ringBuffer.shift()!.length;
  }
}

export function createTerminal(folder: string): string {
  const id = `term_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const shell = process.env.SHELL || '/bin/bash';

  const proc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: folder,
    env: process.env as Record<string, string>,
  });

  const term: LiveTerminal = {
    id,
    folder,
    proc,
    subscribers: new Set(),
    ringBuffer: [],
    ringSize: 0,
    cols: 80,
    rows: 24,
    createdAt: Date.now(),
    exited: false,
  };

  proc.onData((data: string) => {
    const b64 = Buffer.from(data, 'utf-8').toString('base64');
    pushToRingBuffer(term, b64);
    broadcast(term, { type: 'terminal.output', terminalId: id, data: b64 });
  });

  proc.onExit(({ exitCode }) => {
    term.exited = true;
    term.exitCode = exitCode;
    broadcast(term, { type: 'terminal.exited', terminalId: id, exitCode });
    // Keep in map briefly so late-arriving attach can see exitCode, then clean up
    setTimeout(() => terminals.delete(id), 5000);
  });

  terminals.set(id, term);
  return id;
}

export function attachTerminal(ws: WebSocket, terminalId: string): boolean {
  const term = terminals.get(terminalId);
  if (!term) return false;

  term.subscribers.add(ws);

  // Replay ring buffer
  for (const b64 of term.ringBuffer) {
    send(ws, { type: 'terminal.output', terminalId, data: b64 });
  }

  // If already exited, notify
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
  }
}

export function closeTerminal(terminalId: string): void {
  const t = terminals.get(terminalId);
  if (t) {
    if (!t.exited) t.proc.kill();
    terminals.delete(terminalId);
  }
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
  }
  terminals.clear();
}
