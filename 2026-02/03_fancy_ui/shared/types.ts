// ============================================================
// Shared types for Agent UI — WebSocket protocol
// ============================================================

// Backend is a logging tunnel. It does NOT interpret ACP messages.
// Frontend reads raw ACP JSON-RPC and renders UI from it.

export type AgentType = 'claude' | 'codex';

export interface AgentAcpState {
  modes: Array<{ id: string; name: string; description?: string }>;
  currentModeId: string;
  configOptions: Array<{ id: string; name: string; type: string; currentValue: string; options: Array<{ name: string; value?: string }> }>;
}

export interface AgentInfo {
  id: string;
  folder: string;
  agentType: AgentType;
  createdAt: number;
  sessionId?: string;
  acpState?: AgentAcpState;
}

export interface WorkspaceInfo {
  folder: string;
  agentCount: number;
}

export interface TerminalInfo {
  id: string;
  folder: string;
  cols: number;
  rows: number;
  createdAt: number;
}

export interface TabInfo {
  kind: 'agent' | 'terminal';
  id: string;
  label: string;
  agentId?: string;
  terminalId?: string;
}

export interface AgentLogEntry {
  id: number;
  agentId: string;
  direction: 'in' | 'out'; // in = frontend→agent, out = agent→frontend
  payload: unknown; // raw JSON-RPC message
  timestamp: number;
}

// --- WebSocket Protocol: Client → Server ---

export type ClientMessage =
  | { type: 'workspace.list' }
  | { type: 'agent.create'; folder: string; agentType: AgentType }
  | { type: 'agent.list'; folder: string }
  | { type: 'agent.delete'; agentId: string }
  | { type: 'agent.message'; agentId: string; payload: unknown }
  | { type: 'agent.history'; agentId: string; before?: number; limit?: number }
  | { type: 'terminal.create'; folder: string }
  | { type: 'terminal.list'; folder: string }
  | { type: 'terminal.attach'; terminalId: string }
  | { type: 'terminal.input'; terminalId: string; data: string }
  | { type: 'terminal.resize'; terminalId: string; cols: number; rows: number }
  | { type: 'terminal.close'; terminalId: string }
  | { type: 'tabs.update'; folder: string; tabs: TabInfo[]; activeTabId: string | null }
  | { type: 'config.set_preference'; agentType: AgentType; configId: string; value: string };

// --- WebSocket Protocol: Server → Client ---

export type ServerMessage =
  | { type: 'workspace.list.result'; workspaces: WorkspaceInfo[] }
  | { type: 'agent.list.result'; folder: string; agents: AgentInfo[] }
  | { type: 'agent.output'; agentId: string; payload: unknown; direction?: 'in' | 'out' }
  | { type: 'agent.error'; agentId: string; message: string }
  | { type: 'agent.exited'; agentId: string; exitCode: number }
  | { type: 'agent.history.result'; agentId: string; entries: AgentLogEntry[]; hasMore: boolean }
  | { type: 'terminal.list.result'; folder: string; terminals: TerminalInfo[] }
  | { type: 'terminal.created'; terminalId: string }
  | { type: 'terminal.output'; terminalId: string; data: string }
  | { type: 'terminal.exited'; terminalId: string; exitCode: number }
  | { type: 'tabs.state'; folder: string; tabs: TabInfo[]; activeTabId: string | null }
  | { type: 'error'; message: string };
