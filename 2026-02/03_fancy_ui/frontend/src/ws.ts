// WebSocket singleton for communicating with the Agent UI backend.
// One connection per page. Auto-reconnects on disconnect.
// Components subscribe to messages via subscribe(callback).
// Connection status changes via onStatusChange(callback) — for green/red indicator.
// Server URL stored in localStorage('agent-ui-server'), editable from HomePage.

import type { ClientMessage, ServerMessage, TabInfo } from '../../shared/types';

type Listener = (msg: ServerMessage) => void;
type StatusListener = (connected: boolean) => void;
type DisconnectListener = () => void;

let socket: WebSocket | null = null;
let connected = false;
const listeners = new Set<Listener>();
const statusListeners = new Set<StatusListener>();
const disconnectListeners = new Set<DisconnectListener>();
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function getServerUrl(): string {
  return localStorage.getItem('agent-ui-server') || `ws://${location.hostname}:8080`;
}

function setConnected(value: boolean): void {
  if (connected === value) return;
  connected = value;
  for (const fn of statusListeners) fn(value);
}

function connect(): void {
  const url = getServerUrl();
  try {
    socket = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    setConnected(true);
  };

  socket.onmessage = (event) => {
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
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2000);
}

export function send(msg: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function onStatusChange(fn: StatusListener): () => void {
  statusListeners.add(fn);
  // Fire immediately with current state
  fn(connected);
  return () => { statusListeners.delete(fn); };
}

export function onDisconnect(fn: DisconnectListener): () => void {
  disconnectListeners.add(fn);
  return () => { disconnectListeners.delete(fn); };
}

export function isConnected(): boolean {
  return connected;
}

export function getUrl(): string {
  return getServerUrl();
}

export function setServerUrl(url: string): void {
  localStorage.setItem('agent-ui-server', url);
  // Close current connection — reconnect will pick up new URL
  clearTimeout(reconnectTimer);
  socket?.close();
  // Connect immediately to new URL
  setTimeout(connect, 100);
}

export function sendTabsUpdate(folder: string, tabs: TabInfo[], activeTabId: string | null): void {
  send({ type: 'tabs.update', folder, tabs, activeTabId });
}

// Auto-connect on import
connect();
