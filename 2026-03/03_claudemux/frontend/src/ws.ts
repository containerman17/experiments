// WebSocket connection with auto-reconnect.
// Simplified from the old project — no tab state, just message pub/sub.

import type { ClientMessage, ServerMessage } from './types';

export type Listener = (msg: ServerMessage) => void;

export interface Connection {
  start(): void;
  send(msg: ClientMessage): void;
  subscribe(fn: Listener): () => void;
  onStatus(fn: (connected: boolean) => void): () => void;
  close(): void;
}

export function createConnection(url: string): Connection {
  let socket: WebSocket | null = null;
  let connected = false;
  let closed = false;
  let started = false;
  const listeners = new Set<Listener>();
  const statusListeners = new Set<(connected: boolean) => void>();
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  function setConnected(value: boolean): void {
    if (connected === value) return;
    connected = value;
    for (const fn of statusListeners) fn(value);
  }

  function connect(): void {
    if (closed) return;
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      if (closed) { socket?.close(); return; }
      setConnected(true);
    };

    socket.onmessage = (event) => {
      if (closed) return;
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        for (const fn of listeners) fn(msg);
      } catch { /* ignore malformed */ }
    };

    socket.onclose = () => {
      setConnected(false);
      socket = null;
      scheduleReconnect();
    };

    socket.onerror = () => { socket?.close(); };
  }

  function scheduleReconnect(): void {
    if (closed) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  }

  return {
    start() { if (!started) { started = true; connect(); } },
    send(msg: ClientMessage) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    },
    subscribe(fn: Listener) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    onStatus(fn: (connected: boolean) => void) {
      statusListeners.add(fn);
      fn(connected);
      return () => { statusListeners.delete(fn); };
    },
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
      listeners.clear();
      statusListeners.clear();
    },
  };
}
