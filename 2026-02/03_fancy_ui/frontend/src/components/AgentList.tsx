// Left sidebar showing all agents and terminals in the current workspace folder.
// "Create Agent" buttons spawn a new agent via `agent.create`.
// "New Terminal" creates a fresh PTY. Existing terminals are listed and can be reattached.
// Clicking an agent/terminal opens or focuses its tab.
// Fetches terminal.list on mount to discover persistent terminals.

import { useEffect } from 'react';
import { useAppState, useDispatch } from '../store';
import { send } from '../ws';

export function AgentList({ folder }: { folder: string }) {
  const state = useAppState();
  const dispatch = useDispatch();

  // Fetch existing terminals on mount
  useEffect(() => {
    send({ type: 'terminal.list', folder });
  }, [folder]);

  const agents = Object.values(state.agents).filter(a => a.info.folder === folder);
  const terminals = state.terminals.filter(t => t.folder === folder);

  const createAgent = (agentType: 'claude' | 'codex') => {
    send({ type: 'agent.create', folder, agentType });
  };

  const openAgent = (agentId: string) => {
    const existing = state.tabs.find(t => t.kind === 'agent' && t.agentId === agentId);
    if (existing) {
      dispatch({ type: 'SET_ACTIVE_TAB', tabId: existing.id });
    } else {
      const tabId = `tab-${agentId}`;
      const agent = state.agents[agentId];
      const label = `${agent?.info.agentType ?? 'agent'} — ${agentId.slice(0, 12)}`;
      dispatch({ type: 'ADD_TAB', tab: { kind: 'agent', id: tabId, label, agentId } });
      send({ type: 'agent.history', agentId, limit: 50 });
    }
  };

  const openTerminal = (terminalId?: string) => {
    if (terminalId) {
      // Reattach to existing terminal
      const existing = state.tabs.find(t => t.kind === 'terminal' && t.terminalId === terminalId);
      if (existing) {
        dispatch({ type: 'SET_ACTIVE_TAB', tabId: existing.id });
        return;
      }
      const tabId = `tab-${terminalId}`;
      dispatch({ type: 'ADD_TAB', tab: { kind: 'terminal', id: tabId, label: `Terminal — ${terminalId.slice(5, 13)}`, terminalId } });
    } else {
      // Create new terminal
      const tabId = `tab-term-${Date.now()}`;
      dispatch({ type: 'ADD_TAB', tab: { kind: 'terminal', id: tabId, label: 'Terminal (new)' } });
    }
  };

  return (
    <div className="w-[220px] bg-zinc-800 border-r border-zinc-700 shrink-0 flex flex-col overflow-hidden">
      <div className="px-3 py-2 text-xs font-semibold text-zinc-400 uppercase tracking-wide border-b border-zinc-700">
        Agents
      </div>

      <div className="flex-1 overflow-y-auto">
        {agents.length === 0 && terminals.length === 0 && (
          <div className="px-3 py-4 text-sm text-zinc-500 text-center">No agents yet</div>
        )}

        {agents.map(a => {
          const isOpen = state.tabs.some(t => t.kind === 'agent' && t.agentId === a.info.id);
          return (
            <button
              key={a.info.id}
              onClick={() => openAgent(a.info.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-zinc-700 transition-colors ${isOpen ? 'bg-zinc-700' : ''}`}
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${a.error ? 'bg-red-400' : a.busy ? 'bg-blue-400 animate-pulse' : 'bg-green-400'}`} />
              <div className="min-w-0">
                <div className="text-zinc-200 truncate">{a.info.agentType} — {a.info.id.slice(6, 18)}</div>
                <div className="text-zinc-500 text-xs">
                  {a.error ? 'error' : a.acpSessionId ? 'ready' : a.acpInitialized ? 'initializing...' : 'starting...'}
                </div>
              </div>
            </button>
          );
        })}

        {/* Existing terminals */}
        {terminals.map(t => {
          const isOpen = state.tabs.some(tab => tab.kind === 'terminal' && tab.terminalId === t.id);
          return (
            <button
              key={t.id}
              onClick={() => openTerminal(t.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-zinc-700 transition-colors ${isOpen ? 'bg-zinc-700' : ''}`}
            >
              <span className="w-2 h-2 rounded-sm shrink-0 bg-green-400" />
              <div className="min-w-0">
                <div className="text-zinc-200 truncate">Terminal — {t.id.slice(5, 13)}</div>
                <div className="text-zinc-500 text-xs">{t.cols}x{t.rows}</div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="p-2 border-t border-zinc-700 space-y-1">
        <button
          onClick={() => createAgent('claude')}
          className="w-full px-3 py-1.5 text-sm text-blue-400 border border-zinc-600 rounded hover:bg-zinc-700 transition-colors"
        >
          + Claude Agent
        </button>
        <button
          onClick={() => createAgent('codex')}
          className="w-full px-3 py-1.5 text-sm text-purple-400 border border-zinc-600 rounded hover:bg-zinc-700 transition-colors"
        >
          + Codex Agent
        </button>
        <button
          onClick={() => openTerminal()}
          className="w-full px-3 py-1.5 text-sm text-green-400 border border-zinc-600 rounded hover:bg-zinc-700 transition-colors"
        >
          + Terminal
        </button>
      </div>
    </div>
  );
}
