// Workspace page — shown when a workspace is selected.
// Desktop Layout: LeftSidebar (Agents) | AgentChat | DiffStream | RightSidebar (Terminals)
// Mobile Layout: MobileNav | AgentChat

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAppState, useDispatch } from '../store';
import { useConnection } from '../App';
import type { Screen } from '../App';
import { AgentChat } from '../components/AgentChat';
import { LeftSidebar } from '../components/LeftSidebar';
import { RightSidebar } from '../components/RightSidebar';
import { DiffStream } from '../components/DiffStream';
import { MobileNav } from '../components/MobileNav';
import { Terminal } from '../components/Terminal';
import { useIsMobile } from '../hooks/useIsMobile';
import { RecordingProvider } from '../components/RecordingContext';
import { RecordingBar } from '../components/RecordingBar';

function useVisualViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    setHeight(vv.height);
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
      conn.send({ type: 'terminal.list', folder });
    }
  }, [folder, connected, conn]);

  useEffect(() => {
    document.title = folder.split('/').pop() || folder;
    return () => { document.title = 'Agent UI'; };
  }, [folder]);

  const closeProject = () => {
    setScreen({ kind: 'home' });
  };

  const activeAgentId = state.uiActiveAgentId;
  const activeAgent = activeAgentId ? state.agents[activeAgentId] : null;

  return (
    <RecordingProvider>
    <div
      className="flex flex-col bg-zinc-900 text-zinc-100 relative overflow-hidden"
      style={{ height: vvHeight ? `${vvHeight}px` : '100dvh' }}
    >
      {isMobile ? (
        <>
          <MobileNav closeProject={closeProject} />
          <div className="flex-1 min-h-0 flex flex-col relative">
            {activeAgent ? (
              <div key={activeAgent.info.id} className="flex-1 min-h-0 w-full flex flex-col">
                <AgentChat agent={activeAgent} />
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
                Create an agent to get started.
              </div>
            )}
            <RecordingBar activeAgentId={activeAgentId} />
            
            {/* Overlay Mobile Terminal if requested */}
            {state.uiOpenTerminalId && (
              <div className="absolute inset-0 z-40 bg-zinc-900/95 backdrop-blur flex flex-col">
                <div className="flex items-center justify-between p-2 bg-zinc-800 border-b border-zinc-700">
                  <span className="text-xs text-zinc-300 font-mono">Terminal</span>
                  <button onClick={() => dispatch({ type: 'SET_UI_OPEN_TERMINAL', terminalId: null })} className="text-zinc-400 p-1">✕</button>
                </div>
                <div className="flex-1 min-h-0 relative">
                  <Terminal key={state.uiOpenTerminalId} terminalId={state.uiOpenTerminalId} />
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        /* Desktop Cockpit Layout */
        <div className="flex flex-1 min-h-0 w-full">
          {/* 1. Left Vertical Sidebar (Agents) */}
          <LeftSidebar closeProject={closeProject} />

          {/* 2. Main Agent Chat Column */}
          <div className="flex-1 min-w-0 border-r border-zinc-800 flex flex-col relative">
            {activeAgent ? (
              <AgentChat key={`chat-${activeAgent.info.id}`} agent={activeAgent} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
                Select or create an agent.
              </div>
            )}
            <RecordingBar activeAgentId={activeAgentId} />
          </div>

          {/* 3. Diff Stream Column */}
          <div className="flex-1 min-w-0 bg-zinc-950 flex flex-col relative">
            {activeAgent ? (
              <DiffStream key={`diffs-${activeAgent.info.id}`} agent={activeAgent} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-zinc-700 text-sm">
                Waiting for changes...
              </div>
            )}

            {/* 4. Terminal Overlay (slides over DiffStream when active) */}
            {state.uiOpenTerminalId && (
              <div className="absolute inset-0 z-20 bg-zinc-900/95 backdrop-blur shadow-2xl flex flex-col border-l border-zinc-700 transform transition-transform animate-in slide-in-from-right-8 duration-200">
                <div className="flex items-center justify-between px-4 py-2 bg-zinc-800 border-b border-zinc-700">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="text-xs text-zinc-300 font-mono font-semibold">Terminal Session</span>
                  </div>
                  <button 
                    onClick={() => dispatch({ type: 'SET_UI_OPEN_TERMINAL', terminalId: null })}
                    className="text-zinc-500 hover:text-zinc-300 p-1 transition-colors"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex-1 min-h-0 relative p-1">
                  <Terminal key={state.uiOpenTerminalId} terminalId={state.uiOpenTerminalId} />
                </div>
              </div>
            )}
          </div>

          {/* 5. Right Vertical Sidebar (Terminals) */}
          <RightSidebar />
        </div>
      )}

      {!connected && (
        <div className="absolute inset-0 bg-zinc-900 flex flex-col items-center justify-center z-50 gap-4">
          <div className="text-zinc-400 text-lg font-medium">Reconnecting...</div>
          <button
            onClick={closeProject}
            className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
          >
            All Projects
          </button>
        </div>
      )}
    </div>
    </RecordingProvider>
  );
}
