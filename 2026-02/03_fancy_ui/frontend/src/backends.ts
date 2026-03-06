// Backend list persistence in localStorage.
// Each backend is a server the UI can connect to (title + WebSocket URL).

export interface BackendEntry {
  id: string;
  title: string;
  url: string;
}

const STORAGE_KEY = 'agent-ui-backends';

export function loadBackends(): BackendEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as BackendEntry[];
  } catch {
    return [];
  }
}

export function saveBackends(backends: BackendEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(backends));
}

export function addBackend(title: string, url: string): BackendEntry {
  const backends = loadBackends();
  const entry: BackendEntry = { id: crypto.randomUUID(), title, url };
  backends.push(entry);
  saveBackends(backends);
  return entry;
}

export function removeBackend(id: string): void {
  const backends = loadBackends().filter(b => b.id !== id);
  saveBackends(backends);
}
