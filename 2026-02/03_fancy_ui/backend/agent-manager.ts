// Agent manager: spawn ACP processes, pipe stdio, log everything to SQLite.
// The backend does NOT interpret ACP messages — it's a logging tunnel.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { AgentType, AgentInfo, ServerMessage } from '../shared/types.ts';
import { createAgent as dbCreateAgent, archiveAgent, listAgents, getAgent, appendLog, getHistory } from './db.ts';

interface LiveAgent {
  id: string;
  process: ChildProcess;
  subscribers: Set<WebSocket>;
  buffer: string; // partial line buffer for stdout
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
      return { cmd: 'claude', args: ['--acp'] };
    case 'codex':
      return { cmd: 'codex', args: ['--acp'] };
  }
}

export function createAgentProcess(ws: WebSocket, folder: string, agentType: AgentType): void {
  const id = `agent_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  dbCreateAgent(id, folder, agentType);

  const { cmd, args } = agentCommand(agentType);

  let proc: ChildProcess;
  try {
    proc = spawn(cmd, args, {
      cwd: folder,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
  } catch (err) {
    send(ws, { type: 'error', message: `Failed to spawn ${agentType}: ${err}` });
    return;
  }

  const agent: LiveAgent = {
    id,
    process: proc,
    subscribers: new Set([ws]),
    buffer: '',
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

  // Respond with updated agent list
  const agents = listAgents(folder);
  send(ws, { type: 'agent.list.result', folder, agents });
}

export function sendToAgent(ws: WebSocket, agentId: string, payload: unknown): void {
  const agent = liveAgents.get(agentId);
  if (!agent) {
    send(ws, { type: 'error', message: `Agent ${agentId} not running` });
    return;
  }
  agent.subscribers.add(ws);
  appendLog(agentId, 'in', payload);
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
