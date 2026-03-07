import { useSyncExternalStore } from 'react';
import { useAppState } from '../store';
import { useConnection } from '../App';
import { TabIcon } from './TabBar';

function useConnectionStatus() {
  const conn = useConnection();
  return useSyncExternalStore(
    (cb) => conn.onStatusChange(() => cb()),
    () => conn.isConnected(),
  );
}

export function RightSidebar() {
  const state = useAppState();
  const conn = useConnection();
  const connected = useConnectionStatus();

  const terminalTabs = state.tabs.filter(t => t.kind === 'terminal');

  const toggleTerminal = (terminalId: string) => {
    if (!state.folder) return;
    if (state.uiOpenTerminalId === terminalId) {
      // Closing terminal — go back to the active agent tab
      const agentTab = state.tabs.find(t => t.kind === 'agent' && t.agentId === state.uiActiveAgentId);
      conn.sendTabsUpdate(state.folder, state.tabs, agentTab?.id ?? null);
    } else {
      const tab = terminalTabs.find(t => t.terminalId === terminalId);
      if (tab) conn.sendTabsUpdate(state.folder, state.tabs, tab.id);
    }
  };

  const addTerminal = () => {
    if (state.folder) {
      conn.send({ type: 'terminal.create', folder: state.folder });
    }
  };

  return (
    <div className="w-14 bg-zinc-900 border-l border-zinc-800 flex flex-col items-center py-2 shrink-0 z-10">
      <div className="flex-1 w-full flex flex-col items-center gap-2 overflow-y-auto pt-4">
        {terminalTabs.map(tab => {
          const isActive = tab.terminalId === state.uiOpenTerminalId;

          return (
            <button
              key={tab.id}
              onClick={() => tab.terminalId && toggleTerminal(tab.terminalId)}
              className={`w-10 h-10 flex items-center justify-center rounded-lg transition-colors relative ${
                isActive ? 'bg-zinc-800 border-r-2 border-green-500 rounded-r-none w-full mr-1' : 'bg-transparent hover:bg-zinc-800'
              }`}
              title={tab.label}
            >
              <TabIcon kind="terminal" />
            </button>
          );
        })}
      </div>

      <div className="mt-auto pt-4 flex flex-col items-center gap-4">
        <button
          onClick={addTerminal}
          className="w-10 h-10 flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
          title="New Terminal"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5 stroke-current fill-none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </button>

        <span
          className={`w-2.5 h-2.5 rounded-full mb-4 ${connected ? 'bg-green-500' : 'bg-red-500'}`}
          title={connected ? 'Connected' : 'Disconnected'}
        />
      </div>
    </div>
  );
}
