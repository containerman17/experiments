// Global app state using React context + useReducer.
// State shape is driven by the tunnel protocol (shared/types.ts) and raw ACP messages.
// The store does NOT understand ACP internals — it just stores raw messages.
// Individual components parse the ACP payloads they care about.

import { createContext, useContext, type Dispatch } from 'react';
import type { AgentInfo, WorkspaceInfo, AgentLogEntry, TerminalInfo, TabInfo } from '../../shared/types';

// --- Types ---

export interface AgentState {
  info: AgentInfo;
  // ACP session state (populated after initialize + session/new responses)
  acpSessionId?: string;
  acpInitialized: boolean;
  // Raw log entries (most recent messages, loaded from history or live)
  log: AgentLogEntry[];
  hasMoreHistory: boolean;
  // Is the agent currently processing a prompt?
  busy: boolean;
  // Last error from stderr or spawn failure
  error?: string;
}

export interface AppState {
  workspaces: WorkspaceInfo[];
  // Current workspace (derived from URL, only set on workspace page)
  folder: string | null;
  agents: Record<string, AgentState>;
  terminals: TerminalInfo[];
  tabs: TabInfo[];
  activeTabId: string | null;
}

export const initialState: AppState = {
  workspaces: [],
  folder: null,
  agents: {},
  terminals: [],
  tabs: [],
  activeTabId: null,
};

// --- Actions ---

export type Action =
  // Backend protocol messages
  | { type: 'SET_WORKSPACES'; workspaces: WorkspaceInfo[] }
  | { type: 'SET_AGENTS'; folder: string; agents: AgentInfo[] }
  | { type: 'SET_TERMINALS'; folder: string; terminals: TerminalInfo[] }
  | { type: 'AGENT_OUTPUT'; agentId: string; entry: AgentLogEntry }
  | { type: 'AGENT_ERROR'; agentId: string; message: string }
  | { type: 'AGENT_EXITED'; agentId: string; exitCode: number }
  | { type: 'AGENT_HISTORY'; agentId: string; entries: AgentLogEntry[]; hasMore: boolean }
  // ACP lifecycle
  | { type: 'AGENT_INITIALIZED'; agentId: string }
  | { type: 'AGENT_SESSION_CREATED'; agentId: string; acpSessionId: string }
  | { type: 'AGENT_BUSY'; agentId: string; busy: boolean }
  // UI
  | { type: 'SET_FOLDER'; folder: string | null }
  // Tab state from backend
  | { type: 'SET_TABS'; tabs: TabInfo[]; activeTabId: string | null }
  // Clear all data on disconnect (will be re-fetched on reconnect)
  | { type: 'CLEAR_ALL' };

// --- Reducer ---

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_WORKSPACES':
      return { ...state, workspaces: action.workspaces };

    case 'SET_AGENTS': {
      const agents = { ...state.agents };
      // Remove agents no longer in list
      for (const id of Object.keys(agents)) {
        if (agents[id].info.folder === action.folder && !action.agents.find(a => a.id === id)) {
          delete agents[id];
        }
      }
      // Add/update agents
      for (const info of action.agents) {
        agents[info.id] = agents[info.id]
          ? { ...agents[info.id], info }
          : { info, acpInitialized: false, log: [], hasMoreHistory: false, busy: false };
      }
      return { ...state, agents };
    }

    case 'SET_TERMINALS':
      return { ...state, terminals: action.terminals };

    case 'AGENT_OUTPUT': {
      const a = state.agents[action.agentId];
      if (!a) return state;
      return {
        ...state,
        agents: { ...state.agents, [action.agentId]: { ...a, log: [...a.log, action.entry] } },
      };
    }

    case 'AGENT_ERROR': {
      const a = state.agents[action.agentId];
      if (!a) return state;
      return {
        ...state,
        agents: { ...state.agents, [action.agentId]: { ...a, error: action.message } },
      };
    }

    case 'AGENT_EXITED': {
      const a = state.agents[action.agentId];
      if (!a) return state;
      return {
        ...state,
        agents: { ...state.agents, [action.agentId]: { ...a, busy: false } },
      };
    }

    case 'AGENT_HISTORY': {
      const a = state.agents[action.agentId];
      if (!a) return state;
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.agentId]: { ...a, log: [...action.entries, ...a.log], hasMoreHistory: action.hasMore },
        },
      };
    }

    case 'AGENT_INITIALIZED': {
      const a = state.agents[action.agentId];
      if (!a) return state;
      return {
        ...state,
        agents: { ...state.agents, [action.agentId]: { ...a, acpInitialized: true } },
      };
    }

    case 'AGENT_SESSION_CREATED': {
      const a = state.agents[action.agentId];
      if (!a) return state;
      return {
        ...state,
        agents: { ...state.agents, [action.agentId]: { ...a, acpSessionId: action.acpSessionId } },
      };
    }

    case 'AGENT_BUSY': {
      const a = state.agents[action.agentId];
      if (!a) return state;
      return {
        ...state,
        agents: { ...state.agents, [action.agentId]: { ...a, busy: action.busy } },
      };
    }

    case 'SET_FOLDER':
      return { ...state, folder: action.folder };

    case 'SET_TABS':
      return { ...state, tabs: action.tabs, activeTabId: action.activeTabId };

    case 'CLEAR_ALL':
      return { ...initialState, folder: state.folder };

    default:
      return state;
  }
}

// --- Context ---

export const StateCtx = createContext<AppState>(initialState);
export const DispatchCtx = createContext<Dispatch<Action>>(() => {});

export function useAppState() { return useContext(StateCtx); }
export function useDispatch() { return useContext(DispatchCtx); }
