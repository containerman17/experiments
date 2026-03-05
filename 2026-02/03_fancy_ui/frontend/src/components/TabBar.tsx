// Horizontal tab bar. Always visible. Shows open agent chats and terminal tabs.
// Click to switch, X to close. Color-coded: blue dot = agent, green square = terminal.
// Right side: +Agent, +Terminal buttons, connection status dot.
// Tab mutations are sent to backend via tabs.update; local state updates on tabs.state response.

import { useSyncExternalStore } from 'react';
import { useAppState } from '../store';
import { send, sendTabsUpdate, onStatusChange, isConnected } from '../ws';

function useConnectionStatus(): boolean {
  return useSyncExternalStore(
    (cb) => onStatusChange(() => cb()),
    () => isConnected(),
  );
}

export function TabBar() {
  const { tabs, activeTabId, folder } = useAppState();
  const connected = useConnectionStatus();

  if (!folder) return null;

  const setActive = (tabId: string) => {
    sendTabsUpdate(folder, tabs, tabId);
  };

  const closeTab = (tabId: string) => {
    const newTabs = tabs.filter(t => t.id !== tabId);
    const newActive = activeTabId === tabId
      ? (newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null)
      : activeTabId;
    sendTabsUpdate(folder, newTabs, newActive);
  };

  const addAgent = () => {
    send({ type: 'agent.create', folder, agentType: 'claude' });
  };

  const addTerminal = () => {
    send({ type: 'terminal.create', folder });
  };

  return (
    <div className="flex items-center bg-zinc-800 border-b border-zinc-700 shrink-0 h-9">
      {/* Tabs */}
      <div className="flex items-center overflow-x-auto min-w-0 flex-1">
        {tabs.map(tab => {
          const isActive = tab.id === activeTabId;
          const color = tab.kind === 'agent' ? 'text-blue-400' : 'text-green-400';

          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-zinc-700 shrink-0 transition-colors ${
                isActive ? 'bg-zinc-900 border-b-2 border-b-blue-500' : 'bg-zinc-800 hover:bg-zinc-750'
              }`}
            >
              <span className={color}>{tab.kind === 'agent' ? '\u25CF' : '\u25A0'}</span>
              <span className={isActive ? 'text-zinc-100' : 'text-zinc-400'}>{tab.label}</span>
              <span
                onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                className="ml-1 text-zinc-500 hover:text-zinc-300 cursor-pointer"
              >
                ×
              </span>
            </button>
          );
        })}
      </div>

      {/* Right side controls */}
      <div className="flex items-center gap-1 px-2 shrink-0">
        <button
          onClick={addAgent}
          className="px-2 py-1 text-xs text-blue-400 hover:bg-zinc-700 rounded transition-colors"
        >
          +Agent
        </button>
        <button
          onClick={addTerminal}
          className="px-2 py-1 text-xs text-green-400 hover:bg-zinc-700 rounded transition-colors"
        >
          +Terminal
        </button>
        <span
          className={`w-2 h-2 rounded-full ml-1 ${connected ? 'bg-green-500' : 'bg-red-500'}`}
          title={connected ? 'Connected' : 'Disconnected'}
        />
      </div>
    </div>
  );
}
