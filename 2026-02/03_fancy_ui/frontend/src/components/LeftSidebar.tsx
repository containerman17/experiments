import { useState, useRef, useEffect } from 'react';
import { useAppState } from '../store';
import { useConnection } from '../App';
import type { AgentType } from '../../../shared/types';
import { TabIcon } from './TabBar';

export function LeftSidebar({ closeProject }: { closeProject: () => void }) {
  const state = useAppState();
  const conn = useConnection();
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const agentTabs = state.tabs.filter(t => t.kind === 'agent');

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

  const setActive = (agentId: string) => {
    const tab = agentTabs.find(t => t.agentId === agentId);
    if (tab && state.folder) {
      conn.sendTabsUpdate(state.folder, state.tabs, tab.id);
    }
  };

  const closeAgentTab = (tabId: string) => {
    if (!state.folder) return;
    const tab = agentTabs.find(t => t.id === tabId);
    if (!tab?.agentId) return;
    if (!confirm('Close this agent? The session will be lost.')) return;

    const newTabs = state.tabs.filter(t => t.id !== tabId);
    const nextActiveTabId = state.activeTabId === tabId
      ? (newTabs.find(t => t.kind === 'agent')?.id ?? newTabs[newTabs.length - 1]?.id ?? null)
      : state.activeTabId;

    conn.sendTabsUpdate(state.folder, newTabs, nextActiveTabId);
  };

  const addAgent = (agentType: AgentType) => {
    if (state.folder) {
      conn.send({ type: 'agent.create', folder: state.folder, agentType });
    }
    setAgentMenuOpen(false);
  };

  return (
    <div className="w-14 bg-zinc-900 border-r border-zinc-800 flex flex-col items-center py-2 shrink-0 z-10">
      <button
        onClick={closeProject}
        className="w-10 h-10 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg mb-4 transition-colors"
        title="All projects"
      >
        <svg viewBox="0 0 20 20" className="w-5 h-5 fill-current">
          <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
        </svg>
      </button>

      <div className="flex-1 w-full flex flex-col items-center gap-2 overflow-y-auto">
        {agentTabs.map(tab => {
          const isActive = tab.agentId === state.uiActiveAgentId;
          const agentType = tab.agentId ? state.agents[tab.agentId]?.info.agentType : undefined;

          return (
            <div
              key={tab.id}
              className={`group relative ${isActive ? 'w-full pl-1' : 'w-10'}`}
            >
              <button
                onClick={() => tab.agentId && setActive(tab.agentId)}
                className={`w-10 h-10 flex items-center justify-center rounded-lg transition-colors relative ${
                  isActive ? 'bg-zinc-800 border-l-2 border-blue-500 rounded-l-none w-full' : 'bg-transparent hover:bg-zinc-800'
                }`}
                title={tab.label}
              >
                <TabIcon kind="agent" agentType={agentType} />
              </button>
              <button
                onClick={e => {
                  e.stopPropagation();
                  closeAgentTab(tab.id);
                }}
                className="absolute top-0.5 right-0.5 z-10 w-4 h-4 rounded-full border border-zinc-700 bg-zinc-900/95 text-zinc-500 hover:text-zinc-200 hover:border-zinc-500 opacity-0 group-hover:opacity-100 transition-all"
                title="Close agent"
                aria-label={`Close ${tab.label}`}
              >
                <span className="block -mt-px text-[10px] leading-none">×</span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="relative mt-auto pt-4 flex flex-col items-center gap-4" ref={menuRef}>
        {/* Git Status Placeholder */}
        <button
          className="w-10 h-10 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
          title="Git Status"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5 stroke-current fill-none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="18" r="3"></circle>
            <circle cx="6" cy="6" r="3"></circle>
            <path d="M13 6h3a2 2 0 0 1 2 2v7"></path>
            <line x1="6" y1="9" x2="6" y2="21"></line>
          </svg>
        </button>

        <button
          onClick={() => setAgentMenuOpen(v => !v)}
          className="w-10 h-10 flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
          title="New Agent"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5 stroke-current fill-none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </button>
        {agentMenuOpen && (
          <div className="absolute left-full bottom-0 ml-2 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-50 min-w-[140px] overflow-hidden">
            <button onClick={() => addAgent('claude')} className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-700">
              <TabIcon kind="agent" agentType="claude" /> Claude
            </button>
            <button onClick={() => addAgent('codex')} className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-700">
              <TabIcon kind="agent" agentType="codex" /> Codex
            </button>
            <button onClick={() => addAgent('gemini')} className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-700">
              <TabIcon kind="agent" agentType="gemini" /> Gemini
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
