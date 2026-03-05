// Workspace page shown at "/<folder-path>".
// Layout: left sidebar (agent list) | center (chat or terminal) | right sidebar (agent config).
// On mount, sends `agent.list` to get agents in this folder.
// Tab bar at top switches between agent chats and terminals.

import { useEffect } from 'react';
import { useAppState, useDispatch } from '../store';
import { send } from '../ws';
import { AgentList } from '../components/AgentList';
import { AgentChat } from '../components/AgentChat';
import { AgentSidebar } from '../components/AgentSidebar';
import { TabBar } from '../components/TabBar';
import { Terminal } from '../components/Terminal';

export function WorkspacePage({ folder }: { folder: string }) {
  const state = useAppState();
  const dispatch = useDispatch();

  // Set folder in state and fetch agent list
  useEffect(() => {
    dispatch({ type: 'SET_FOLDER', folder });
    send({ type: 'agent.list', folder });
  }, [folder, dispatch]);

  const activeTab = state.tabs.find(t => t.id === state.activeTabId);
  const activeAgent = activeTab?.kind === 'agent' && activeTab.agentId
    ? state.agents[activeTab.agentId]
    : null;

  const folderName = folder.split('/').pop() || folder;

  return (
    <div className="flex flex-col h-screen bg-zinc-900 text-zinc-100">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-3 h-10 bg-zinc-800 border-b border-zinc-700 shrink-0">
        <a href="/" className="text-zinc-400 hover:text-zinc-200 text-sm transition-colors">Workspaces</a>
        <span className="text-zinc-600 text-sm">/</span>
        <span className="text-zinc-200 text-sm font-medium" title={folder}>{folderName}</span>
        <div className="flex-1" />
      </div>

      {/* Tab bar */}
      <TabBar />

      {/* Main area */}
      <div className="flex flex-1 min-h-0">
        {/* Left: agent list */}
        <AgentList folder={folder} />

        {/* Center: content */}
        <div className="flex-1 min-w-0 flex flex-col">
          {activeTab?.kind === 'agent' && activeAgent && (
            <AgentChat agent={activeAgent} />
          )}
          {activeTab?.kind === 'terminal' && (
            <Terminal folder={folder} tabId={activeTab.id} terminalId={activeTab.terminalId} />
          )}
          {!activeTab && (
            <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
              Create an agent or open a terminal to get started.
            </div>
          )}
        </div>

        {/* Right: agent sidebar */}
        {activeAgent && <AgentSidebar agent={activeAgent} />}
      </div>
    </div>
  );
}
