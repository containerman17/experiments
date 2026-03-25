// Tunnel manager: spawns cloudflared quick tunnels for local ports.
// Each tunnel is a child process that maps a trycloudflare.com URL to localhost:PORT.
// Ephemeral — tunnels don't survive server restarts.

import { spawn, type ChildProcess } from 'node:child_process';
import type { TunnelInfo } from '../frontend/src/types.ts';

interface LiveTunnel {
  port: number;
  url: string | null;
  status: 'starting' | 'running' | 'error';
  error?: string;
  proc: ChildProcess;
}

const tunnels = new Map<number, LiveTunnel>();
let onChange: (() => void) | null = null;

// Register a callback for when tunnel state changes (for broadcasting to clients)
export function onTunnelChange(fn: () => void): void {
  onChange = fn;
}

function notify(): void {
  onChange?.();
}

export function createTunnel(port: number): TunnelInfo {
  if (tunnels.has(port)) {
    const t = tunnels.get(port)!;
    return { port: t.port, url: t.url, status: t.status, error: t.error };
  }

  const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const tunnel: LiveTunnel = { port, url: null, status: 'starting', proc };
  tunnels.set(port, tunnel);
  notify();

  proc.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString();
    const match = line.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
    if (match && tunnel.status === 'starting') {
      tunnel.url = match[0];
      tunnel.status = 'running';
      console.log(`[tunnel] port ${port} → ${tunnel.url}`);
      notify();
    }
  });

  proc.on('error', (err) => {
    tunnel.status = 'error';
    tunnel.error = err.message;
    console.error(`[tunnel] port ${port} error: ${err.message}`);
    notify();
  });

  proc.on('exit', (code) => {
    if (tunnels.get(port) === tunnel) {
      tunnel.status = 'error';
      tunnel.error = `Process exited with code ${code}`;
      console.log(`[tunnel] port ${port} exited (code ${code})`);
      tunnels.delete(port);
      notify();
    }
  });

  // Timeout: if no URL after 15s, mark as error
  setTimeout(() => {
    if (tunnel.status === 'starting') {
      tunnel.status = 'error';
      tunnel.error = 'Timeout waiting for tunnel URL';
      notify();
    }
  }, 15_000);

  return { port: tunnel.port, url: tunnel.url, status: tunnel.status };
}

export function deleteTunnel(port: number): void {
  const tunnel = tunnels.get(port);
  if (!tunnel) return;
  tunnel.proc.kill();
  tunnels.delete(port);
  console.log(`[tunnel] port ${port} deleted`);
  notify();
}

export function listTunnels(): TunnelInfo[] {
  return [...tunnels.values()].map(t => ({
    port: t.port,
    url: t.url,
    status: t.status,
    error: t.error,
  }));
}

export function closeAllTunnels(): void {
  for (const tunnel of tunnels.values()) {
    tunnel.proc.kill();
  }
  tunnels.clear();
}
