import type { TabInfo } from '../shared/types.ts';

interface TabState {
  tabs: TabInfo[];
  activeTabId: string | null;
}

const store = new Map<string, TabState>();

export function getTabState(folder: string): TabState {
  return store.get(folder) ?? { tabs: [], activeTabId: null };
}

export function setTabState(folder: string, tabs: TabInfo[], activeTabId: string | null): TabState {
  const state = { tabs, activeTabId };
  store.set(folder, state);
  return state;
}
