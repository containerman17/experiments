// Horizontal tab bar. Always visible. Shows open agent chats and terminal tabs.
// Click to switch, X to close. Color-coded: blue dot = agent, green square = terminal.
// Left side: project name + close icon. Right side: +New menu, connection status dot.

import { useState, useRef, useEffect, useSyncExternalStore } from 'react';
import { useAppState } from '../store';
import { useConnection } from '../App';
import type { AgentType } from '../../../shared/types';

function useConnectionStatus() {
  const conn = useConnection();
  return useSyncExternalStore(
    (cb) => conn.onStatusChange(() => cb()),
    () => conn.isConnected(),
  );
}

export function TabIcon({ kind, agentType }: { kind: 'agent' | 'terminal'; agentType?: AgentType }) {
  if (kind === 'terminal') {
    return (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="#4ADE80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    );
  }
  if (agentType === 'claude') {
    return (
      <svg viewBox="0 0 64 64" className="w-3.5 h-3.5 shrink-0">
        <path d="M37.4 17.2L47.8 46.8H56L42.6 10H32.2L37.4 17.2Z" fill="#D4A27F" />
        <path d="M26.6 10L8 46.8H16.4L21.2 35.6H38L40.2 46.8H48.2L36.4 10H26.6ZM23.8 28.8L31.4 13.6L36.2 28.8H23.8Z" fill="#D4A27F" />
      </svg>
    );
  }
  if (agentType === 'codex') {
    return (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="#10B981" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2.7L3.5 7.5v9.1L12 21.3l8.5-4.8V7.5L12 2.7z" />
        <path d="M12 7.5v9M7.5 10l9 5M16.5 10l-9 5" />
      </svg>
    );
  }
  if (agentType === 'gemini') {
    return (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0" fill="#4285F4">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3l2.5 5.5L20 12l-5.5 1.5L12 19l-2.5-5.5L4 12l5.5-1.5L12 5z" />
      </svg>
    );
  }
  return <span className="text-blue-400">●</span>;
}

export function TabBar({ closeProject }: { closeProject: () => void }) {
  const { tabs, activeTabId, folder, agents } = useAppState();
  const conn = useConnection();
  const connected = useConnectionStatus();
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
    conn.sendTabsUpdate(folder, tabs, tabId);
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

  const renameTab = (tabId: string, newLabel: string) => {
    const trimmed = newLabel.trim();
    if (!trimmed) { setEditingTabId(null); return; }
    const newTabs = tabs.map(t => t.id === tabId ? { ...t, label: trimmed } : t);
    conn.sendTabsUpdate(folder, newTabs, activeTabId);
    setEditingTabId(null);
  };

  const addAgent = (agentType: AgentType) => {
    conn.send({ type: 'agent.create', folder, agentType });
    setAgentMenuOpen(false);
  };

  const addTerminal = () => {
    conn.send({ type: 'terminal.create', folder });
  };

  return (
    <div className="flex items-center bg-zinc-800 border-b border-zinc-700 shrink-0 h-9">
      {/* Back to projects */}
      <button
        onClick={closeProject}
        className="flex items-center justify-center w-9 h-full text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/50 border-r border-zinc-700 shrink-0 transition-colors"
        title="All projects"
      >
        <svg viewBox="0 0 20 20" className="w-4 h-4 fill-current" aria-hidden="true">
          <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
        </svg>
      </button>

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
            className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
          >
            + New ▾
          </button>
          {agentMenuOpen && (
            <div className="absolute right-0 top-full mt-1 bg-zinc-700 border border-zinc-600 rounded shadow-lg z-50 min-w-[140px]">
              <button
                onClick={() => addAgent('claude')}
                className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-600 rounded-t"
              >
                <TabIcon kind="agent" agentType="claude" /> Claude
              </button>
              <button
                onClick={() => addAgent('codex')}
                className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-600"
              >
                <TabIcon kind="agent" agentType="codex" /> Codex
              </button>
              <button
                onClick={() => addAgent('gemini')}
                className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-600"
              >
                <TabIcon kind="agent" agentType="gemini" /> Gemini
              </button>
              <div className="border-t border-zinc-600" />
              <button
                onClick={() => { addTerminal(); setAgentMenuOpen(false); }}
                className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-600 rounded-b"
              >
                <TabIcon kind="terminal" /> Terminal
              </button>
            </div>
          )}
        </div>
        <span
          className={`w-2 h-2 rounded-full ml-1 ${connected ? 'bg-green-500' : 'bg-red-500'}`}
          title={connected ? 'Connected' : 'Disconnected'}
        />
      </div>
    </div>
  );
}
