// Horizontal tab bar. Shows open agent chats and terminal tabs.
// Click to switch, X to close. Color-coded: blue=agent, green=terminal.

import { useAppState, useDispatch } from '../store';

export function TabBar() {
  const { tabs, activeTabId } = useAppState();
  const dispatch = useDispatch();

  if (tabs.length === 0) return null;

  return (
    <div className="flex items-center bg-zinc-800 border-b border-zinc-700 shrink-0 overflow-x-auto">
      {tabs.map(tab => {
        const isActive = tab.id === activeTabId;
        const color = tab.kind === 'agent' ? 'text-blue-400' : 'text-green-400';

        return (
          <button
            key={tab.id}
            onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tabId: tab.id })}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-zinc-700 shrink-0 transition-colors ${
              isActive ? 'bg-zinc-900 border-b-2 border-b-blue-500' : 'bg-zinc-800 hover:bg-zinc-750'
            }`}
          >
            <span className={color}>{tab.kind === 'agent' ? '\u25CF' : '\u25A0'}</span>
            <span className={isActive ? 'text-zinc-100' : 'text-zinc-400'}>{tab.label}</span>
            <span
              onClick={e => { e.stopPropagation(); dispatch({ type: 'CLOSE_TAB', tabId: tab.id }); }}
              className="ml-1 text-zinc-500 hover:text-zinc-300 cursor-pointer"
            >
              \u00D7
            </span>
          </button>
        );
      })}
    </div>
  );
}
