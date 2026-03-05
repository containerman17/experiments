// Agent manager: spawn ACP processes, pipe stdio, log everything to SQLite.
// The backend does NOT interpret ACP messages — it's a logging tunnel.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { AgentType, AgentInfo, ServerMessage } from '../shared/types.ts';
import { createAgent as dbCreateAgent, archiveAgent, listAgents, getAgent, appendLog, getHistory, getConfigPreferences, setAgentSessionId, setAgentAcpState } from './db.ts';

interface LiveAgent {
  id: string;
  agentType: AgentType;
  process: ChildProcess;
  subscribers: Set<WebSocket>;
  buffer: string; // partial line buffer for stdout
  acpSessionId?: string; // set after initialize + session/new completes
  nextRpcId: number;
  pendingSetMode: Map<number, string>; // request ID → modeId for session/set_mode
}

let nextRpcId = 1;
function rpcRequest(method: string, params: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: nextRpcId++, method, params };
}

const liveAgents = new Map<string, LiveAgent>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(agent: LiveAgent, msg: ServerMessage): void {
  for (const ws of agent.subscribers) send(ws, msg);
}

function agentCommand(agentType: AgentType): { cmd: string; args: string[] } {
  switch (agentType) {
    case 'claude':
      return { cmd: 'claude-agent-acp', args: [] };
    case 'codex':
      return { cmd: 'codex-acp', args: [] };
    case 'gemini':
      return { cmd: 'gemini', args: ['--experimental-acp', '-m', 'gemini-3.1-pro-preview'] };
  }
}

export function createAgentProcess(ws: WebSocket, folder: string, agentType: AgentType): string | null {
  const id = `agent_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  dbCreateAgent(id, folder, agentType);

  const { cmd, args } = agentCommand(agentType);

  let proc: ChildProcess;
  try {
    proc = spawn(cmd, args, {
      cwd: folder,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(agentType === 'claude' ? { CLAUDECODE: '' } : {}),
      },
    });
  } catch (err) {
    send(ws, { type: 'error', message: `Failed to spawn ${agentType}: ${err}` });
    return null;
  }

  const agent: LiveAgent = {
    id,
    agentType,
    process: proc,
    subscribers: new Set([ws]),
    buffer: '',
    nextRpcId: 1,
    pendingSetMode: new Map(),
  };
  liveAgents.set(id, agent);

  // Read newline-delimited JSON-RPC from stdout
  proc.stdout!.on('data', (chunk: Buffer) => {
    agent.buffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = agent.buffer.indexOf('\n')) >= 0) {
      const line = agent.buffer.slice(0, newlineIdx).trim();
      agent.buffer = agent.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const payload = JSON.parse(line);
        appendLog(id, 'out', payload);
        broadcast(agent, { type: 'agent.output', agentId: id, payload });

        // ACP lifecycle: initialize response → send session/new
        if (!agent.acpSessionId && payload.id !== undefined && !payload.method && payload.result?.protocolVersion) {
          const sessionNew = rpcRequest('session/new', { cwd: folder, mcpServers: [] });
          appendLog(id, 'in', sessionNew);
          proc.stdin!.write(JSON.stringify(sessionNew) + '\n');
          broadcast(agent, { type: 'agent.output', agentId: id, payload: sessionNew, direction: 'in' });
        }

        // ACP lifecycle: session/new response → store sessionId + apply saved preferences
        if (!agent.acpSessionId && payload.id !== undefined && !payload.method && payload.result?.sessionId) {
          agent.acpSessionId = payload.result.sessionId;
          setAgentSessionId(id, payload.result.sessionId);
          // Gemini nests modes under result.modes.{availableModes,currentModeId}
          setAgentAcpState(id, {
            modes: payload.result.availableModes || payload.result.modes?.availableModes || [],
            currentModeId: payload.result.currentModeId || payload.result.modes?.currentModeId || '',
            configOptions: payload.result.configOptions || [],
          });

          // Apply saved preferences for this agent type
          const prefs = getConfigPreferences(agent.agentType);

          // Restore preferred mode if saved and different from default
          const savedMode = prefs['__mode__'];
          const currentModeId = payload.result.currentModeId || payload.result.modes?.currentModeId || '';
          if (savedMode && savedMode !== currentModeId) {
            const setModeReq = rpcRequest('session/set_mode', {
              sessionId: payload.result.sessionId, modeId: savedMode,
            });
            agent.pendingSetMode.set(setModeReq.id, savedMode);
            appendLog(id, 'in', setModeReq);
            proc.stdin!.write(JSON.stringify(setModeReq) + '\n');
            broadcast(agent, { type: 'agent.output', agentId: id, payload: setModeReq, direction: 'in' });
          }

          // Restore config option preferences
          for (const [configId, value] of Object.entries(prefs)) {
            if (configId === '__mode__') continue;
            const setReq = rpcRequest('session/set_config_option', {
              sessionId: payload.result.sessionId, configId, value,
            });
            appendLog(id, 'in', setReq);
            proc.stdin!.write(JSON.stringify(setReq) + '\n');
            broadcast(agent, { type: 'agent.output', agentId: id, payload: setReq, direction: 'in' });
          }
        }

        // session/set_mode response — update persisted mode.
        // Gemini returns empty {} for set_mode, so we correlate via pendingSetMode map.
        if (!payload.method && payload.id !== undefined) {
          const modeId = payload.result?.currentModeId || agent.pendingSetMode.get(payload.id);
          if (modeId) {
            agent.pendingSetMode.delete(payload.id);
            const info = getAgent(id);
            if (info?.acpState) {
              info.acpState.currentModeId = modeId;
              setAgentAcpState(id, info.acpState);
            }
          }
        }

        // Update persisted ACP state on mode/config changes
        if (payload.method === 'current_mode_update' && payload.params?.modeId) {
          const info = getAgent(id);
          if (info?.acpState) {
            info.acpState.currentModeId = payload.params.modeId;
            setAgentAcpState(id, info.acpState);
          }
        }
        if (payload.method === 'config_options_update' && payload.params?.configOptions) {
          const info = getAgent(id);
          if (info?.acpState) {
            info.acpState.configOptions = payload.params.configOptions;
            setAgentAcpState(id, info.acpState);
          }
        }
        if (!payload.method && payload.result?.configOptions) {
          const info = getAgent(id);
          if (info?.acpState) {
            info.acpState.configOptions = payload.result.configOptions;
            setAgentAcpState(id, info.acpState);
          }
        }

        // Auto-grant permission requests (backend handles this so agents work without a frontend)
        if (payload.method === 'session/request_permission' && payload.id != null) {
          const firstOption = payload.params?.options?.[0];
          const grant = {
            jsonrpc: '2.0',
            id: payload.id,
            result: { outcome: { outcome: 'selected', optionId: firstOption?.optionId || '' } },
          };
          appendLog(id, 'in', grant);
          proc.stdin!.write(JSON.stringify(grant) + '\n');
          broadcast(agent, { type: 'agent.output', agentId: id, payload: grant });
        }
      } catch {
        console.error(`[agent ${id}] non-JSON stdout:`, line);
      }
    }
  });

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) return;
    console.error(`[agent ${id}] stderr:`, text);
    appendLog(id, 'out', { type: 'stderr', message: text });
    broadcast(agent, { type: 'agent.error', agentId: id, message: text });
  });

  proc.on('exit', (code) => {
    liveAgents.delete(id);
    broadcast(agent, { type: 'agent.exited', agentId: id, exitCode: code ?? 1 });
  });

  proc.on('error', (err) => {
    console.error(`[agent ${id}] process error:`, err);
    liveAgents.delete(id);
    broadcast(agent, { type: 'agent.exited', agentId: id, exitCode: 1 });
  });

  // Send ACP initialize immediately
  const initReq = rpcRequest('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'agent-ui', title: 'Agent UI', version: '0.1.0' },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  appendLog(id, 'in', initReq);
  proc.stdin!.write(JSON.stringify(initReq) + '\n');

  // Respond with updated agent list
  const agents = listAgents(folder);
  send(ws, { type: 'agent.list.result', folder, agents });

  return id;
}

export function sendToAgent(ws: WebSocket, agentId: string, payload: unknown): void {
  const agent = liveAgents.get(agentId);
  if (!agent) {
    send(ws, { type: 'error', message: `Agent ${agentId} not running` });
    return;
  }
  agent.subscribers.add(ws);
  appendLog(agentId, 'in', payload);
  // Track session/set_mode requests for matching responses
  const p = payload as any;
  if (p.method === 'session/set_mode' && p.id !== undefined && p.params?.modeId) {
    agent.pendingSetMode.set(p.id, p.params.modeId);
  }
  // Echo back to all subscribers so frontends see user messages immediately
  broadcast(agent, { type: 'agent.output', agentId, payload, direction: 'in' });
  agent.process.stdin!.write(JSON.stringify(payload) + '\n');
}

export function deleteAgent(ws: WebSocket, agentId: string): void {
  const info = getAgent(agentId);
  if (!info) {
    send(ws, { type: 'error', message: `Agent ${agentId} not found` });
    return;
  }

  const agent = liveAgents.get(agentId);
  if (agent) {
    agent.process.kill();
    liveAgents.delete(agentId);
  }

  archiveAgent(agentId);
  const agents = listAgents(info.folder);
  send(ws, { type: 'agent.list.result', folder: info.folder, agents });
}

export function listAgentsInFolder(ws: WebSocket, folder: string): void {
  const agents = listAgents(folder);
  send(ws, { type: 'agent.list.result', folder, agents });
}

export function getAgentHistory(ws: WebSocket, agentId: string, before?: number, limit = 50): void {
  const result = getHistory(agentId, limit, before);
  send(ws, { type: 'agent.history.result', agentId, entries: result.entries, hasMore: result.hasMore });
}

export function subscribeToAgent(ws: WebSocket, agentId: string): void {
  const agent = liveAgents.get(agentId);
  if (agent) agent.subscribers.add(ws);
}

export function unsubscribeAll(ws: WebSocket): void {
  for (const agent of liveAgents.values()) {
    agent.subscribers.delete(ws);
  }
}
