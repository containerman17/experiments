// Root component. Routes by window.location.pathname — no SPA router.
// "/" = home page (workspace list + folder input)
// "/<folder-path>" = workspace page (agents, chat, terminals)
// Also sets up the global store and WebSocket message bridge.

import { useReducer, useEffect } from 'react';
import { StateCtx, DispatchCtx, initialState, reducer } from './store';
import { subscribe as wsSubscribe } from './ws';
import { HomePage } from './pages/HomePage';
import { WorkspacePage } from './pages/WorkspacePage';
import type { ServerMessage } from '../../shared/types';

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Bridge WebSocket messages into the store
  useEffect(() => {
    return wsSubscribe((msg: ServerMessage) => {
      switch (msg.type) {
        case 'workspace.list.result':
          dispatch({ type: 'SET_WORKSPACES', workspaces: msg.workspaces });
          break;
        case 'agent.list.result':
          dispatch({ type: 'SET_AGENTS', folder: msg.folder, agents: msg.agents });
          break;
        case 'agent.output':
          dispatch({
            type: 'AGENT_OUTPUT',
            agentId: msg.agentId,
            entry: { id: Date.now(), agentId: msg.agentId, direction: 'out', payload: msg.payload, timestamp: Date.now() },
          });
          break;
        case 'agent.error':
          dispatch({ type: 'AGENT_ERROR', agentId: msg.agentId, message: msg.message });
          break;
        case 'agent.exited':
          dispatch({ type: 'AGENT_EXITED', agentId: msg.agentId, exitCode: msg.exitCode });
          break;
        case 'agent.history.result':
          dispatch({ type: 'AGENT_HISTORY', agentId: msg.agentId, entries: msg.entries, hasMore: msg.hasMore });
          break;
        case 'terminal.list.result':
          dispatch({ type: 'SET_TERMINALS', folder: msg.folder, terminals: msg.terminals });
          break;
        // Terminal output/exit messages are handled directly by Terminal component
      }
    });
  }, []);

  // Determine which page to show based on URL
  const path = window.location.pathname;
  const isHome = path === '/';

  return (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>
        {isHome ? <HomePage /> : <WorkspacePage folder={path} />}
      </DispatchCtx.Provider>
    </StateCtx.Provider>
  );
}
