// Mobile navigation: hamburger button in a top bar + slide-out drawer.
// Shows the same tabs as TabBar but in a vertical list.
// Hidden on desktop (md+), visible on mobile only.

import { useState, useRef, useEffect } from 'react';
import { useAppState } from '../store';
import { useConnection } from '../App';
import { TabIcon } from './TabBar';

export function MobileNav({ closeProject }: { closeProject: () => void }) {
  const { tabs, activeTabId, folder, agents } = useAppState();
  const conn = useConnection();
  const [open, setOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!folder) return null;

  const activeTab = tabs.find(t => t.id === activeTabId);

  const setActive = (tabId: string) => {
    conn.sendTabsUpdate(folder, tabs, tabId);
    setOpen(false);
  };

  const closeTab = (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (tab?.kind === 'agent' && !confirm('Close this agent? The session will be lost.')) return;
    if (tab?.kind === 'terminal' && !confirm('Close this terminal?')) return;
    const newTabs = tabs.filter(t => t.id !== tabId);
    const newActive = activeTabId === tabId
      ? (newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null)
      : activeTabId;
    conn.sendTabsUpdate(folder, newTabs, newActive);
  };

  const addAgent = (agentType: 'claude' | 'codex' | 'gemini') => {
    conn.send({ type: 'agent.create', folder, agentType });
  };

  const addTerminal = () => {
    conn.send({ type: 'terminal.create', folder });
  };

  return (
    <>
      {/* Top bar with hamburger + active tab label */}
      <div className="flex items-center bg-zinc-800 border-b border-zinc-700 shrink-0 h-11 px-3 gap-3">
        <button
          onClick={() => setOpen(v => !v)}
          className="flex flex-col gap-1 w-6 h-6 items-center justify-center"
          aria-label="Menu"
        >
          <span className="block w-4 h-0.5 bg-zinc-300 rounded" />
          <span className="block w-4 h-0.5 bg-zinc-300 rounded" />
          <span className="block w-4 h-0.5 bg-zinc-300 rounded" />
        </button>
        {activeTab && (
          <div className="flex items-center gap-1.5 text-sm text-zinc-200 truncate min-w-0">
            <TabIcon
              kind={activeTab.kind}
              agentType={activeTab.agentId ? agents[activeTab.agentId]?.info.agentType : undefined}
            />
            <span className="truncate">{activeTab.label}</span>
          </div>
        )}
      </div>

      {/* Backdrop */}
      {open && (
        <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setOpen(false)} />
      )}

      {/* Slide-out drawer */}
      <div
        ref={drawerRef}
        className={`fixed top-0 left-0 bottom-0 w-72 bg-zinc-800 border-r border-zinc-700 z-50 transform transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-zinc-700">
          <span className="text-sm font-medium text-zinc-200">Tabs</span>
          <button onClick={() => setOpen(false)} className="text-zinc-400 text-lg">×</button>
        </div>

        {/* Tab list */}
        <div className="flex-1 overflow-y-auto py-2">
          {tabs.map(tab => {
            const isActive = tab.id === activeTabId;
            const agentType = tab.agentId ? agents[tab.agentId]?.info.agentType : undefined;

            return (
              <div
                key={tab.id}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
                  isActive ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 active:bg-zinc-750'
                }`}
                onClick={() => setActive(tab.id)}
              >
                <TabIcon kind={tab.kind} agentType={agentType} />
                <span className="flex-1 truncate">{tab.label}</span>
                <button
                  onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                  className="text-zinc-500 hover:text-zinc-300 px-1"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        {/* Add buttons + Close Project */}
        <div className="border-t border-zinc-700 p-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              onClick={() => addAgent('claude')}
              className="flex-1 px-3 py-2 text-xs text-zinc-200 bg-zinc-700 rounded active:bg-zinc-600 transition-colors"
            >
              + Claude
            </button>
            <button
              onClick={() => addAgent('codex')}
              className="flex-1 px-3 py-2 text-xs text-zinc-200 bg-zinc-700 rounded active:bg-zinc-600 transition-colors"
            >
              + Codex
            </button>
            <button
              onClick={() => addAgent('gemini')}
              className="flex-1 px-3 py-2 text-xs text-zinc-200 bg-zinc-700 rounded active:bg-zinc-600 transition-colors"
            >
              + Gemini
            </button>
          </div>
          <button
            onClick={addTerminal}
            className="w-full px-3 py-2 text-xs text-green-400 bg-zinc-700 rounded active:bg-zinc-600 transition-colors"
          >
            + Terminal
          </button>
          <button
            onClick={() => { setOpen(false); closeProject(); }}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-zinc-400 bg-zinc-700 rounded active:bg-zinc-600 transition-colors border border-zinc-600"
          >
            <svg viewBox="0 0 20 20" className="w-3.5 h-3.5 fill-current" aria-hidden="true">
              <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
            </svg>
            All Projects
          </button>
        </div>
      </div>
    </>
  );
}
