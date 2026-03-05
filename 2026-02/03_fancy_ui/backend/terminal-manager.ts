import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';

interface Terminal {
  id: string;
  pty: pty.IPty;
}

const terminals = new Map<string, Terminal>();

export function createTerminal(
  workspacePath: string,
  onOutput: (terminalId: string, data: string) => void,
  onExit: (terminalId: string, exitCode: number) => void,
): string {
  const id = randomUUID();
  const shell = process.env.SHELL || '/bin/bash';

  const proc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: workspacePath,
    env: process.env as Record<string, string>,
  });

  proc.onData((data: string) => {
    const b64 = Buffer.from(data, 'utf-8').toString('base64');
    onOutput(id, b64);
  });

  proc.onExit(({ exitCode }) => {
    terminals.delete(id);
    onExit(id, exitCode);
  });

  terminals.set(id, { id, pty: proc });
  return id;
}

export function writeToTerminal(terminalId: string, data: string): void {
  const t = terminals.get(terminalId);
  if (t) t.pty.write(data);
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): void {
  const t = terminals.get(terminalId);
  if (t) t.pty.resize(cols, rows);
}

export function closeTerminal(terminalId: string): void {
  const t = terminals.get(terminalId);
  if (t) {
    t.pty.kill();
    terminals.delete(terminalId);
  }
}

export function closeAll(): void {
  for (const t of terminals.values()) {
    t.pty.kill();
  }
  terminals.clear();
}
