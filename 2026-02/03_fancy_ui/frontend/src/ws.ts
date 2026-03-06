// WebSocket connection manager.
// createConnection(url) returns an isolated connection object with its own listeners.
// Each connection auto-reconnects until close() is called.

import type { ClientMessage, ServerMessage, TabInfo } from '../../shared/types';

export type Listener = (msg: ServerMessage) => void;
export type StatusListener = (connected: boolean) => void;
export type DisconnectListener = () => void;

export interface WsConnection {
  /** Call after setting up subscribers. Connection does NOT auto-connect. */
  start(): void;
  send(msg: ClientMessage): void;
  subscribe(fn: Listener): () => void;
  onStatusChange(fn: StatusListener): () => void;
  onDisconnect(fn: DisconnectListener): () => void;
  isConnected(): boolean;
  close(): void;
  sendTabsUpdate(folder: string, tabs: TabInfo[], activeTabId: string | null): void;
}

export function createConnection(url: string): WsConnection {
  let socket: WebSocket | null = null;
  let connected = false;
  let closed = false;
  let started = false;
  const listeners = new Set<Listener>();
  const statusListeners = new Set<StatusListener>();
  const disconnectListeners = new Set<DisconnectListener>();
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
      for (const fn of disconnectListeners) fn();
      scheduleReconnect();
    };

    socket.onerror = () => {
      socket?.close();
    };
  }

  function scheduleReconnect(): void {
    if (closed) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  }

  function send(msg: ClientMessage): void {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  function close(): void {
    closed = true;
    clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
    listeners.clear();
    statusListeners.clear();
    disconnectListeners.clear();
  }

  // Don't auto-connect — caller must call start() after setting up subscribers

  return {
    start() { if (!started) { started = true; connect(); } },
    send,
    subscribe(fn: Listener) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    onStatusChange(fn: StatusListener) {
      statusListeners.add(fn);
      fn(connected);
      return () => { statusListeners.delete(fn); };
    },
    onDisconnect(fn: DisconnectListener) {
      disconnectListeners.add(fn);
      return () => { disconnectListeners.delete(fn); };
    },
    isConnected: () => connected,
    close,
    sendTabsUpdate(folder: string, tabs: TabInfo[], activeTabId: string | null) {
      send({ type: 'tabs.update', folder, tabs, activeTabId });
    },
  };
}
