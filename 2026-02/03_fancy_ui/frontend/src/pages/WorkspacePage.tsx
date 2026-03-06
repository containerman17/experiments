// Workspace page — shown when a workspace is selected.
// Layout: TabBar on top, content area below (flex-1).
// "Close Project" button in top-left returns to main screen.
// Disconnected overlay when WebSocket is not connected.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAppState, useDispatch } from '../store';
import { useConnection } from '../App';
import type { Screen } from '../App';
import { AgentChat } from '../components/AgentChat';
import { TabBar } from '../components/TabBar';
import { MobileNav } from '../components/MobileNav';
import { Terminal } from '../components/Terminal';
import { useIsMobile } from '../hooks/useIsMobile';

function useVisualViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setHeight(vv.height);
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);
  return height;
}

export function WorkspacePage({ folder, setScreen }: { folder: string; setScreen: (s: Screen) => void }) {
  const state = useAppState();
  const dispatch = useDispatch();
  const conn = useConnection();
  const isMobile = useIsMobile();
  const vvHeight = useVisualViewportHeight();

  const connected = useSyncExternalStore(
    (cb) => conn.onStatusChange(() => cb()),
    () => conn.isConnected(),
  );

  useEffect(() => {
    dispatch({ type: 'SET_FOLDER', folder });
  }, [folder, dispatch]);

  useEffect(() => {
    if (connected) {
      conn.send({ type: 'agent.list', folder });
    }
  }, [folder, connected, conn]);

  useEffect(() => {
    document.title = folder.split('/').pop() || folder;
    return () => { document.title = 'Agent UI'; };
  }, [folder]);

  const closeProject = () => {
    setScreen({ kind: 'home' });
  };

  const activeTab = state.tabs.find(t => t.id === state.activeTabId);
  const activeAgentId = activeTab?.kind === 'agent' ? activeTab.agentId : null;
  const activeAgent = activeAgentId ? state.agents[activeAgentId] : null;

  return (
    <div
      className="flex flex-col bg-zinc-900 text-zinc-100 relative"
      style={{ height: vvHeight ? `${vvHeight}px` : '100dvh' }}
    >
      {isMobile ? <MobileNav closeProject={closeProject} /> : <TabBar closeProject={closeProject} />}

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

      {!connected && (
        <div className="absolute inset-0 bg-zinc-900 flex items-center justify-center z-50">
          <div className="text-zinc-400 text-lg font-medium">Reconnecting...</div>
        </div>
      )}
    </div>
  );
}
