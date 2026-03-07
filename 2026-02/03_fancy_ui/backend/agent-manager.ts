// Agent manager: spawn ACP processes, pipe stdio, log everything to SQLite.
// The backend does NOT interpret ACP messages — it's a logging tunnel.
// Dead agents are auto-revived on message send using session/load (if supported) or session/new.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { AgentType, AgentInfo, ServerMessage } from '../shared/types.ts';
import { createAgent as dbCreateAgent, archiveAgent, listAgents, getAgent, appendLog, getHistory, getConfigPreferences, setAgentSessionId, setAgentAcpState } from './db.ts';
import { ToolCallNormalizer } from './tool-call-normalizer.ts';

interface LiveAgent {
  id: string;
  agentType: AgentType;
  folder: string;
  process: ChildProcess;
  subscribers: Set<WebSocket>;
  buffer: string; // partial line buffer for stdout
  acpSessionId?: string; // set after initialize + session/new|load completes
  loadSession?: boolean; // from initialize response — can we resume sessions?
  nextRpcId: number;
  pendingSetMode: Map<number, string>; // request ID → modeId for session/set_mode
  toolCallNormalizer: ToolCallNormalizer; // merges tool_call + tool_call_update
  // When reviving, queue messages to send after session is ready
  pendingMessages: Array<{ ws: WebSocket; payload: unknown }>;
  reviving: boolean;
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

// Spawn an agent process and wire up stdio handling.
// If `existingSessionId` is provided, uses session/load instead of session/new after initialize.
function spawnAndWire(
  agent: LiveAgent,
  existingSessionId?: string,
): ChildProcess {
  const { cmd, args } = agentCommand(agent.agentType);
  const proc = spawn(cmd, args, {
    cwd: agent.folder,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(agent.agentType === 'claude' ? { CLAUDECODE: '' } : {}),
    },
  });

  const id = agent.id;
  const folder = agent.folder;

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
        appendLog(id, 'out', payload); // SQLite always gets raw

        // Normalize tool_call messages before broadcasting to frontends
        const normalized = agent.toolCallNormalizer.process(payload);
        if (normalized) {
          // Replace the update inside the session/update envelope with the merged version
          const normalizedPayload = JSON.parse(JSON.stringify(payload));
          (normalizedPayload as any).params.update = normalized;
          broadcast(agent, { type: 'agent.output', agentId: id, payload: normalizedPayload });
        } else {
          broadcast(agent, { type: 'agent.output', agentId: id, payload });
        }

        // ACP lifecycle: initialize response → capture loadSession, then send session/new or session/load
        if (!agent.acpSessionId && payload.id !== undefined && !payload.method && payload.result?.protocolVersion) {
          // Capture loadSession capability from initialize response
          agent.loadSession = !!payload.result.capabilities?.loadSession;

          if (existingSessionId && agent.loadSession) {
            // Resume existing session
            console.log(`[agent ${id}] resuming session ${existingSessionId} via session/load`);
            const sessionLoad = rpcRequest('session/load', {
              sessionId: existingSessionId, cwd: folder, mcpServers: [],
            });
            appendLog(id, 'in', sessionLoad);
            proc.stdin!.write(JSON.stringify(sessionLoad) + '\n');
            broadcast(agent, { type: 'agent.output', agentId: id, payload: sessionLoad, direction: 'in' });
          } else {
            // New session
            const sessionNew = rpcRequest('session/new', { cwd: folder, mcpServers: [] });
            appendLog(id, 'in', sessionNew);
            proc.stdin!.write(JSON.stringify(sessionNew) + '\n');
            broadcast(agent, { type: 'agent.output', agentId: id, payload: sessionNew, direction: 'in' });
          }
        }

        // ACP lifecycle: session/new or session/load response → store sessionId + apply saved preferences
        if (!agent.acpSessionId && payload.id !== undefined && !payload.method && payload.result?.sessionId) {
          agent.acpSessionId = payload.result.sessionId;
          setAgentSessionId(id, payload.result.sessionId);
          // Gemini nests modes under result.modes.{availableModes,currentModeId}
          setAgentAcpState(id, {
            modes: payload.result.availableModes || payload.result.modes?.availableModes || [],
            currentModeId: payload.result.currentModeId || payload.result.modes?.currentModeId || '',
            configOptions: payload.result.configOptions || [],
            promptCapabilities: payload.result.promptCapabilities || undefined,
            loadSession: agent.loadSession,
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

          // Flush any messages queued during revive
          if (agent.pendingMessages.length > 0) {
            console.log(`[agent ${id}] session ready, flushing ${agent.pendingMessages.length} queued message(s)`);
            for (const { ws, payload: queuedPayload } of agent.pendingMessages) {
              // Rewrite sessionId in queued prompts to use the new session
              const p = queuedPayload as any;
              if (p.params?.sessionId) {
                p.params.sessionId = payload.result.sessionId;
              }
              agent.subscribers.add(ws);
              appendLog(id, 'in', queuedPayload);
              broadcast(agent, { type: 'agent.output', agentId: id, payload: queuedPayload, direction: 'in' });
              proc.stdin!.write(JSON.stringify(queuedPayload) + '\n');
            }
            agent.pendingMessages = [];
          }
          agent.reviving = false;
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
    console.log(`[agent ${id}] process exited (code ${code})`);
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

  return proc;
}

// Revive a dead agent — respawn the process and resume or create a new session.
function reviveAgent(ws: WebSocket, agentId: string): LiveAgent | null {
  const info = getAgent(agentId);
  if (!info) return null;

  console.log(`[agent ${agentId}] reviving (loadSession=${info.acpState?.loadSession}, sessionId=${info.sessionId})`);

  const agent: LiveAgent = {
    id: agentId,
    agentType: info.agentType,
    folder: info.folder,
    process: null as any, // will be set by spawnAndWire
    subscribers: new Set([ws]),
    buffer: '',
    nextRpcId: 1,
    pendingSetMode: new Map(),
    toolCallNormalizer: new ToolCallNormalizer(),
    pendingMessages: [],
    reviving: true,
  };

  try {
    const existingSessionId = info.acpState?.loadSession && info.sessionId ? info.sessionId : undefined;
    agent.process = spawnAndWire(agent, existingSessionId);
  } catch (err) {
    console.error(`[agent ${agentId}] failed to revive:`, err);
    send(ws, { type: 'agent.error', agentId, message: `Failed to revive agent: ${err}` });
    return null;
  }

  liveAgents.set(agentId, agent);
  return agent;
}

export function createAgentProcess(ws: WebSocket, folder: string, agentType: AgentType): string | null {
  const id = `agent_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  dbCreateAgent(id, folder, agentType);

  const agent: LiveAgent = {
    id,
    agentType,
    folder,
    process: null as any,
    subscribers: new Set([ws]),
    buffer: '',
    nextRpcId: 1,
    pendingSetMode: new Map(),
    toolCallNormalizer: new ToolCallNormalizer(),
    pendingMessages: [],
    reviving: false,
  };

  try {
    agent.process = spawnAndWire(agent);
  } catch (err) {
    send(ws, { type: 'error', message: `Failed to spawn ${agentType}: ${err}` });
    return null;
  }

  liveAgents.set(id, agent);

  // Respond with updated agent list
  const agents = listAgents(folder);
  send(ws, { type: 'agent.list.result', folder, agents });

  return id;
}

export function sendToAgent(ws: WebSocket, agentId: string, payload: unknown): void {
  let agent = liveAgents.get(agentId);

  // Auto-revive dead agents
  if (!agent) {
    console.log(`[agent ${agentId}] not running — attempting auto-revive`);
    agent = reviveAgent(ws, agentId);
    if (!agent) {
      send(ws, { type: 'agent.error', agentId, message: 'Agent process not running and could not be revived.' });
      return;
    }
  }

  agent.subscribers.add(ws);

  // If still initializing (reviving), queue the message for delivery after session is ready
  if (!agent.acpSessionId) {
    console.log(`[agent ${agentId}] session not ready, queuing message`);
    agent.pendingMessages.push({ ws, payload });
    return;
  }

  // Rewrite sessionId to the current session (frontend may have stale ID after revive)
  const p = payload as any;
  if (p.params?.sessionId && agent.acpSessionId && p.params.sessionId !== agent.acpSessionId) {
    console.log(`[agent ${agentId}] rewriting stale sessionId ${p.params.sessionId} → ${agent.acpSessionId}`);
    p.params.sessionId = agent.acpSessionId;
  }
  console.log(`[agent ${agentId}] → stdin: ${p?.method || 'response'}`);
  appendLog(agentId, 'in', payload);
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

  // Normalize tool call messages in history replay (same merge as live stream)
  const normalizer = new ToolCallNormalizer();
  const normalizedEntries = result.entries.map((entry: any) => {
    if (entry.direction !== 'out') return entry;
    const normalized = normalizer.process(entry.payload);
    if (!normalized) return entry;
    const normalizedPayload = JSON.parse(JSON.stringify(entry.payload));
    normalizedPayload.params.update = normalized;
    return { ...entry, payload: normalizedPayload };
  });

  send(ws, { type: 'agent.history.result', agentId, entries: normalizedEntries, hasMore: result.hasMore });
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
