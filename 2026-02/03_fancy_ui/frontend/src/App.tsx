// Root component. State-based navigation (no URL routing).
// 'home' screen shows all backends + workspaces.
// 'workspace' screen connects to one backend and shows the workspace view.

import { useReducer, useEffect, useRef, useState, createContext, useContext } from 'react';
import { StateCtx, DispatchCtx, initialState, reducer } from './store';
import { createConnection, type WsConnection } from './ws';
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

// Key for connection identity — changes when we enter a new workspace
function screenKey(s: Screen): string {
  return s.kind === 'home' ? '' : `${s.backendUrl}::${s.folder}`;
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });

  // Connection is managed via ref to survive StrictMode double-invoke.
  // We track which screenKey the connection belongs to.
  const connRef = useRef<{ key: string; conn: WsConnection } | null>(null);
  const [conn, setConn] = useState<WsConnection | null>(null);

  const key = screenKey(screen);

  // Create/destroy connection synchronously when screen changes
  // Using a ref + state combo: ref for identity, state for rendering
  if (screen.kind === 'workspace') {
    if (!connRef.current || connRef.current.key !== key) {
      // Close old connection if any
      connRef.current?.conn.close();
      const connection = createConnection(screen.backendUrl);
      connRef.current = { key, conn: connection };
      // setConn will trigger re-render with the connection available
      if (conn !== connection) {
        // Can't call setState during render in strict sense, but we need it
        // for the context. Use a microtask to avoid React warnings.
        queueMicrotask(() => setConn(connection));
      }
    }
  } else {
    if (connRef.current) {
      connRef.current.conn.close();
      connRef.current = null;
      if (conn !== null) {
        queueMicrotask(() => setConn(null));
      }
    }
  }

  // Subscribe to messages and manage cleanup
  useEffect(() => {
    const entry = connRef.current;
    if (!entry || entry.key !== key) return;
    const connection = entry.conn;

    // Ensure state is in sync (handles StrictMode re-runs)
    setConn(connection);
    dispatch({ type: 'CLEAR_ALL' });

    const unsubDisconnect = connection.onDisconnect(() => {
      if (connRef.current?.conn !== connection) return;
      dispatch({ type: 'CLEAR_ALL' });
    });

    const unsubMessages = connection.subscribe((msg: ServerMessage) => {
      if (connRef.current?.conn !== connection) return;
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

    return () => {
      unsubDisconnect();
      unsubMessages();
      // Don't close connection here — StrictMode would kill it.
      // Connection is closed when screen changes (above).
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close connection on unmount
  useEffect(() => {
    return () => {
      connRef.current?.conn.close();
      connRef.current = null;
    };
  }, []);

  // Resolve the connection for rendering — use ref directly for synchronous access
  const activeConn = connRef.current?.key === key ? connRef.current.conn : null;

  return (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>
        <ConnectionCtx.Provider value={activeConn}>
          {screen.kind === 'home' ? (
            <MainScreen setScreen={setScreen} />
          ) : activeConn ? (
            <WorkspacePage folder={screen.folder} setScreen={setScreen} />
          ) : null}
        </ConnectionCtx.Provider>
      </DispatchCtx.Provider>
    </StateCtx.Provider>
  );
}
