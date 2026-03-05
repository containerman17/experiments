import type { TabInfo } from '../shared/types.ts';
import { saveTabState, loadTabState } from './db.ts';

interface TabState {
  tabs: TabInfo[];
  activeTabId: string | null;
}

// In-memory cache backed by SQLite
const store = new Map<string, TabState>();

export function getTabState(folder: string): TabState {
  if (store.has(folder)) return store.get(folder)!;

  // Load from SQLite on first access
  const saved = loadTabState(folder);
  if (saved) {
    const tabs = saved.tabs as TabInfo[];
    const activeTabId = tabs.some(t => t.id === saved.activeTabId) ? saved.activeTabId : (tabs[0]?.id ?? null);
    const state = { tabs, activeTabId };
    store.set(folder, state);
    return state;
  }

  return { tabs: [], activeTabId: null };
}

export function setTabState(folder: string, tabs: TabInfo[], activeTabId: string | null): TabState {
  const state = { tabs, activeTabId };
  store.set(folder, state);
  saveTabState(folder, tabs, activeTabId);
  return state;
}
