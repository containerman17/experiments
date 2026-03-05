// Horizontal tab bar. Always visible. Shows open agent chats and terminal tabs.
// Click to switch, X to close. Color-coded: blue dot = agent, green square = terminal.
// Right side: +Agent, +Terminal buttons, connection status dot.
// Tab mutations are sent to backend via tabs.update; local state updates on tabs.state response.

import { useState, useRef, useEffect, useSyncExternalStore } from 'react';
import { useAppState } from '../store';
import type { AgentType } from '../../../shared/types';
import { send, sendTabsUpdate, onStatusChange, isConnected } from '../ws';

function useConnectionStatus(): boolean {
  return useSyncExternalStore(
    (cb) => onStatusChange(() => cb()),
    () => isConnected(),
  );
}

export function TabIcon({ kind, agentType }: { kind: 'agent' | 'terminal'; agentType?: AgentType }) {
  if (kind === 'terminal') {
    return <span className="text-green-400">■</span>;
  }
  if (agentType === 'claude') {
    // Anthropic Claude logo mark (simplified)
    return (
      <svg viewBox="0 0 64 64" className="w-3.5 h-3.5 shrink-0">
        <path d="M37.4 17.2L47.8 46.8H56L42.6 10H32.2L37.4 17.2Z" fill="#D4A27F" />
        <path d="M26.6 10L8 46.8H16.4L21.2 35.6H38L40.2 46.8H48.2L36.4 10H26.6ZM23.8 28.8L31.4 13.6L36.2 28.8H23.8Z" fill="#D4A27F" />
      </svg>
    );
  }
  if (agentType === 'codex') {
    // OpenAI logo mark (simplified hexagonal knot)
    return (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="#10B981" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2.7L3.5 7.5v9.1L12 21.3l8.5-4.8V7.5L12 2.7z" />
        <path d="M12 7.5v9M7.5 10l9 5M16.5 10l-9 5" />
      </svg>
    );
  }
  return <span className="text-blue-400">●</span>;
}

export function TabBar() {
  const { tabs, activeTabId, folder, agents } = useAppState();
  const connected = useConnectionStatus();
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!agentMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setAgentMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [agentMenuOpen]);

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

  const renameTab = (tabId: string, newLabel: string) => {
    const trimmed = newLabel.trim();
    if (!trimmed) { setEditingTabId(null); return; }
    const newTabs = tabs.map(t => t.id === tabId ? { ...t, label: trimmed } : t);
    sendTabsUpdate(folder, newTabs, activeTabId);
    setEditingTabId(null);
  };

  const addAgent = (agentType: 'claude' | 'codex') => {
    send({ type: 'agent.create', folder, agentType });
    setAgentMenuOpen(false);
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
          const agentType = tab.agentId ? agents[tab.agentId]?.info.agentType : undefined;

          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-zinc-700 shrink-0 transition-colors ${
                isActive ? 'bg-zinc-900 border-b-2 border-b-blue-500' : 'bg-zinc-800 hover:bg-zinc-750'
              }`}
            >
              <TabIcon kind={tab.kind} agentType={agentType} />
              {editingTabId === tab.id ? (
                <input
                  ref={inputRef}
                  defaultValue={tab.label}
                  autoFocus
                  className="bg-zinc-700 text-zinc-100 text-xs px-1 rounded outline-none w-24"
                  onBlur={e => renameTab(tab.id, e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') renameTab(tab.id, e.currentTarget.value);
                    if (e.key === 'Escape') setEditingTabId(null);
                  }}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span
                  className={isActive ? 'text-zinc-100' : 'text-zinc-400'}
                  onDoubleClick={e => { e.stopPropagation(); setEditingTabId(tab.id); }}
                >
                  {tab.label}
                </span>
              )}
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
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setAgentMenuOpen(v => !v)}
            className="px-2 py-1 text-xs text-blue-400 hover:bg-zinc-700 rounded transition-colors"
          >
            +Agent ▾
          </button>
          {agentMenuOpen && (
            <div className="absolute right-0 top-full mt-1 bg-zinc-700 border border-zinc-600 rounded shadow-lg z-50 min-w-[120px]">
              <button
                onClick={() => addAgent('claude')}
                className="block w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-600 rounded-t"
              >
                Claude
              </button>
              <button
                onClick={() => addAgent('codex')}
                className="block w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-600 rounded-b"
              >
                Codex
              </button>
            </div>
          )}
        </div>
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
