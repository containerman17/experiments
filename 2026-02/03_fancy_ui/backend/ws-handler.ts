import type WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/types.ts';
import { listWorkspaces } from './db.ts';
import { createAgentProcess, sendToAgent, deleteAgent, listAgentsInFolder, getAgentHistory, subscribeToAgent, unsubscribeAll } from './agent-manager.ts';
import { createTerminal, attachTerminal, detachAll, listTerminals, writeToTerminal, resizeTerminal, closeTerminal } from './terminal-manager.ts';

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
    detachAll(ws);
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
      const terminalId = createTerminal(msg.folder);
      // Auto-attach the creator
      attachTerminal(ws, terminalId);
      send(ws, { type: 'terminal.created', terminalId });
      break;
    }

    case 'terminal.list': {
      const terms = listTerminals(msg.folder);
      send(ws, { type: 'terminal.list.result', folder: msg.folder, terminals: terms });
      break;
    }

    case 'terminal.attach': {
      const ok = attachTerminal(ws, msg.terminalId);
      if (!ok) sendError(ws, `Terminal ${msg.terminalId} not found`);
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
      break;
    }

    default: {
      sendError(ws, `Unknown message type: ${(msg as any).type}`);
    }
  }
}
