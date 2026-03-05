// Workspace page shown at "/<folder-path>".
// Layout: TabBar on top, content area below (flex-1).
// No left sidebar. Agent sidebar on right only when agent tab is active.
// Disconnected overlay when WebSocket is not connected.

import { useEffect, useSyncExternalStore } from 'react';
import { useAppState, useDispatch } from '../store';
import { send, onStatusChange, isConnected } from '../ws';
import { AgentChat } from '../components/AgentChat';
import { TabBar } from '../components/TabBar';
import { MobileNav } from '../components/MobileNav';
import { Terminal } from '../components/Terminal';
import { useIsMobile } from '../hooks/useIsMobile';

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
  const isMobile = useIsMobile();

  // Set folder in state and fetch agent list (re-fetch on reconnect)
  useEffect(() => {
    dispatch({ type: 'SET_FOLDER', folder });
  }, [folder, dispatch]);

  useEffect(() => {
    if (connected) {
      send({ type: 'agent.list', folder });
    }
  }, [folder, connected]);

  // Set document.title to last path segment
  useEffect(() => {
    document.title = folder.split('/').pop() || folder;
  }, [folder]);

  const activeTab = state.tabs.find(t => t.id === state.activeTabId);
  const activeAgentId = activeTab?.kind === 'agent' ? activeTab.agentId : null;
  const activeAgent = activeAgentId ? state.agents[activeAgentId] : null;

  return (
    <div className="flex flex-col h-dvh bg-zinc-900 text-zinc-100 relative">
      {/* Navigation: TabBar on desktop, MobileNav on mobile */}
      {isMobile ? <MobileNav /> : <TabBar />}

      {/* Main area */}
      <div className="flex-1 min-h-0 flex flex-col">
        {activeTab?.kind === 'agent' && activeAgent && (
          <div key={activeTab.id} className="flex-1 min-h-0 w-full">
            <AgentChat agent={activeAgent} />
          </div>
        )}
        {activeTab?.kind === 'terminal' && activeTab.terminalId && (
          <Terminal key={activeTab.terminalId} terminalId={activeTab.terminalId} />
        )}
        {!activeTab && (
          <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
            Create an agent or open a terminal to get started.
          </div>
        )}
      </div>

      {/* Disconnected overlay */}
      {!connected && (
        <div className="absolute inset-0 bg-zinc-900 flex items-center justify-center z-50">
          <div className="text-zinc-400 text-lg font-medium">Reconnecting...</div>
        </div>
      )}
    </div>
  );
}
