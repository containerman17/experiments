import type WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/types.ts';
import { listWorkspaces } from './db.ts';
import { createAgentProcess, sendToAgent, deleteAgent, listAgentsInFolder, getAgentHistory, subscribeToAgent, unsubscribeAll } from './agent-manager.ts';
import { createTerminal, writeToTerminal, resizeTerminal, closeTerminal } from './terminal-manager.ts';

// Track terminals per connection for cleanup
const wsTerminals = new Map<WebSocket, Set<string>>();

function trackTerminal(ws: WebSocket, terminalId: string): void {
  let set = wsTerminals.get(ws);
  if (!set) { set = new Set(); wsTerminals.set(ws, set); }
  set.add(terminalId);
}

function untrackTerminal(ws: WebSocket, terminalId: string): void {
  wsTerminals.get(ws)?.delete(terminalId);
}

function closeAllTerminals(ws: WebSocket): void {
  const set = wsTerminals.get(ws);
  if (set) {
    for (const id of set) closeTerminal(id);
    wsTerminals.delete(ws);
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendError(ws: WebSocket, message: string): void {
  send(ws, { type: 'error', message });
}

export function handleConnection(ws: WebSocket): void {
  ws.on('message', (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendError(ws, 'Invalid JSON');
      return;
    }
    handleMessage(ws, msg).catch(err => {
      console.error('Handler error:', err);
      sendError(ws, String(err));
    });
  });

  ws.on('close', () => {
    unsubscribeAll(ws);
    closeAllTerminals(ws);
  });
}

async function handleMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
  switch (msg.type) {
    case 'workspace.list': {
      const workspaces = listWorkspaces();
      send(ws, { type: 'workspace.list.result', workspaces });
      break;
    }

    case 'agent.create': {
      createAgentProcess(ws, msg.folder, msg.agentType);
      break;
    }

    case 'agent.list': {
      listAgentsInFolder(ws, msg.folder);
      break;
    }

    case 'agent.delete': {
      deleteAgent(ws, msg.agentId);
      break;
    }

    case 'agent.message': {
      sendToAgent(ws, msg.agentId, msg.payload);
      break;
    }

    case 'agent.history': {
      getAgentHistory(ws, msg.agentId, msg.before, msg.limit ?? 50);
      break;
    }

    case 'terminal.create': {
      const terminalId = createTerminal(
        msg.folder,
        (id, data) => send(ws, { type: 'terminal.output', terminalId: id, data }),
        (id, exitCode) => {
          send(ws, { type: 'terminal.exited', terminalId: id, exitCode });
          untrackTerminal(ws, id);
        },
      );
      trackTerminal(ws, terminalId);
      send(ws, { type: 'terminal.created', terminalId });
      break;
    }

    case 'terminal.input': {
      writeToTerminal(msg.terminalId, msg.data);
      break;
    }

    case 'terminal.resize': {
      resizeTerminal(msg.terminalId, msg.cols, msg.rows);
      break;
    }

    case 'terminal.close': {
      closeTerminal(msg.terminalId);
      untrackTerminal(ws, msg.terminalId);
      break;
    }

    default: {
      sendError(ws, `Unknown message type: ${(msg as any).type}`);
    }
  }
}
