// Global app state using React context + useReducer.
// State shape is driven by the tunnel protocol (shared/types.ts) and raw ACP messages.
// The store does NOT understand ACP internals — it just stores raw messages.
// Individual components parse the ACP payloads they care about.

import { createContext, useContext, type Dispatch } from 'react';
import type { AgentInfo, WorkspaceInfo, AgentLogEntry } from '../../shared/types';

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

export interface TabDef {
  kind: 'agent' | 'terminal';
  id: string;
  label: string;
  agentId?: string;     // for agent tabs
  terminalId?: string;  // set after terminal.created
}

export interface AppState {
  workspaces: WorkspaceInfo[];
  // Current workspace (derived from URL, only set on workspace page)
  folder: string | null;
  agents: Record<string, AgentState>;
  tabs: TabDef[];
  activeTabId: string | null;
}

export const initialState: AppState = {
  workspaces: [],
  folder: null,
  agents: {},
  tabs: [],
  activeTabId: null,
};

// --- Actions ---

export type Action =
  // Backend protocol messages
  | { type: 'SET_WORKSPACES'; workspaces: WorkspaceInfo[] }
  | { type: 'SET_AGENTS'; folder: string; agents: AgentInfo[] }
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
  | { type: 'ADD_TAB'; tab: TabDef }
  | { type: 'SET_ACTIVE_TAB'; tabId: string }
  | { type: 'CLOSE_TAB'; tabId: string }
  | { type: 'SET_TERMINAL_ID'; tabId: string; terminalId: string };

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

    case 'ADD_TAB':
      return { ...state, tabs: [...state.tabs, action.tab], activeTabId: action.tab.id };

    case 'SET_ACTIVE_TAB':
      return { ...state, activeTabId: action.tabId };

    case 'CLOSE_TAB': {
      const tabs = state.tabs.filter(t => t.id !== action.tabId);
      const activeTabId = state.activeTabId === action.tabId
        ? (tabs.length > 0 ? tabs[tabs.length - 1].id : null)
        : state.activeTabId;
      return { ...state, tabs, activeTabId };
    }

    case 'SET_TERMINAL_ID':
      return {
        ...state,
        tabs: state.tabs.map(t =>
          t.id === action.tabId ? { ...t, terminalId: action.terminalId } : t
        ),
      };

    default:
      return state;
  }
}

// --- Context ---

export const StateCtx = createContext<AppState>(initialState);
export const DispatchCtx = createContext<Dispatch<Action>>(() => {});

export function useAppState() { return useContext(StateCtx); }
export function useDispatch() { return useContext(DispatchCtx); }
