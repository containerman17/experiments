// Root component. State-based navigation (no URL routing).
// 'home' screen shows all backends + workspaces.
// 'workspace' screen connects to one backend and shows the workspace view.
//
// Connection lifecycle is entirely managed in a single useEffect keyed on screen.
// No render-phase side effects, no refs, no microtasks.

import { useReducer, useEffect, useState, createContext, useContext } from 'react';
import { StateCtx, DispatchCtx, initialState, reducer } from './store';
import { createConnection, type WsConnection } from './ws';
import { loadLastScreen, saveLastScreen } from './backends';
import { MainScreen } from './pages/MainScreen';
import { WorkspacePage } from './pages/WorkspacePage';
import type { ServerMessage } from '../../shared/types';

export type Screen =
  | { kind: 'home' }
  | { kind: 'workspace'; backendId: string; backendUrl: string; folder: string };

// Connection context — components use this instead of importing ws.ts directly
export const ConnectionCtx = createContext<WsConnection | null>(null);

export function useConnection(): WsConnection {
  const conn = useContext(ConnectionCtx);
  if (!conn) throw new Error('No active connection');
  return conn;
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [screen, setScreenRaw] = useState<Screen>(() => {
    const last = loadLastScreen();
    if (last) return { kind: 'workspace', ...last };
    return { kind: 'home' };
  });
  const [conn, setConn] = useState<WsConnection | null>(null);

  const setScreen = (s: Screen) => {
    if (s.kind === 'workspace') {
      saveLastScreen({ backendId: s.backendId, backendUrl: s.backendUrl, folder: s.folder });
    } else {
      saveLastScreen(null);
    }
    setScreenRaw(s);
  };

  // Single effect manages the entire connection lifecycle.
  // Creates connection, subscribes, starts, and cleans up on screen change.
  useEffect(() => {
    if (screen.kind !== 'workspace') {
      // On home screen, no connection needed
      setConn(null);
      dispatch({ type: 'CLEAR_ALL' });
      return;
    }

    dispatch({ type: 'CLEAR_ALL' });

    const connection = createConnection(screen.backendUrl);
    setConn(connection);

    const unsubDisconnect = connection.onDisconnect(() => {
      dispatch({ type: 'CLEAR_ALL' });
    });

    const unsubMessages = connection.subscribe((msg: ServerMessage) => {
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
            entry: { id: Date.now(), agentId: msg.agentId, direction: msg.direction || 'out', payload: msg.payload, timestamp: Date.now() },
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
        case 'tabs.state':
          dispatch({ type: 'SET_TABS', tabs: msg.tabs, activeTabId: msg.activeTabId });
          break;
      }
    });

    // All subscribers set up — now connect
    connection.start();

    return () => {
      unsubDisconnect();
      unsubMessages();
      connection.close();
      setConn(null);
    };
  }, [screen.kind === 'workspace' ? `${screen.backendUrl}::${screen.folder}` : '']);

  return (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>
        <ConnectionCtx.Provider value={conn}>
          {screen.kind === 'home' ? (
            <MainScreen setScreen={setScreen} />
          ) : conn ? (
            <WorkspacePage folder={screen.folder} setScreen={setScreen} />
          ) : (
            <div className="h-dvh bg-zinc-900 flex items-center justify-center">
              <div className="text-zinc-400 text-lg">Connecting...</div>
            </div>
          )}
        </ConnectionCtx.Provider>
      </DispatchCtx.Provider>
    </StateCtx.Provider>
  );
}
