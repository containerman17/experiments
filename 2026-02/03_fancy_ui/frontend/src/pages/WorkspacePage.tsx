// Workspace page shown at "/<folder-path>".
// Layout: TabBar on top, content area below (flex-1).
// No left sidebar. Agent sidebar on right only when agent tab is active.
// Disconnected overlay when WebSocket is not connected.

import { useEffect, useSyncExternalStore } from 'react';
import { useAppState, useDispatch } from '../store';
import { send, onStatusChange, isConnected } from '../ws';
import { AgentChat } from '../components/AgentChat';
import { AgentSidebar } from '../components/AgentSidebar';
import { TabBar } from '../components/TabBar';
import { Terminal } from '../components/Terminal';

function useConnectionStatus(): boolean {
  return useSyncExternalStore(
    (cb) => onStatusChange(() => cb()),
    () => isConnected(),
  );
}

export function WorkspacePage({ folder }: { folder: string }) {
  const state = useAppState();
  const dispatch = useDispatch();
  const connected = useConnectionStatus();

  // Set folder in state and fetch agent list
  useEffect(() => {
    dispatch({ type: 'SET_FOLDER', folder });
    send({ type: 'agent.list', folder });
  }, [folder, dispatch]);

  // Set document.title to last path segment
  useEffect(() => {
    document.title = folder.split('/').pop() || folder;
  }, [folder]);

  const activeTab = state.tabs.find(t => t.id === state.activeTabId);
  const activeAgent = activeTab?.kind === 'agent' && activeTab.agentId
    ? state.agents[activeTab.agentId]
    : null;

  return (
    <div className="flex flex-col h-screen bg-zinc-900 text-zinc-100 relative">
      {/* Tab bar */}
      <TabBar />

      {/* Main area */}
      <div className="flex flex-1 min-h-0">
        {/* Center: content */}
        <div className="flex-1 min-w-0 flex flex-col">
          {activeTab?.kind === 'agent' && activeAgent && (
            <div className="flex-1 min-h-0 max-w-4xl mx-auto w-full">
              <AgentChat agent={activeAgent} />
            </div>
          )}
          {activeTab?.kind === 'terminal' && activeTab.terminalId && (
            <Terminal terminalId={activeTab.terminalId} />
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

      {/* Disconnected overlay */}
      {!connected && (
        <div className="absolute inset-0 bg-zinc-900/60 flex items-center justify-center z-50">
          <div className="text-zinc-400 text-lg font-medium">Disconnected</div>
        </div>
      )}
    </div>
  );
}
