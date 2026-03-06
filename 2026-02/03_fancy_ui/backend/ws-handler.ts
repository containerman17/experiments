import type WebSocket from 'ws';
import type { WebSocketServer } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/types.ts';
import { listWorkspaces, setConfigPreference, getAgent, getHistory } from './db.ts';
import { createAgentProcess, sendToAgent, deleteAgent, listAgentsInFolder, getAgentHistory, subscribeToAgent, unsubscribeAll } from './agent-manager.ts';
import { createTerminal, attachTerminal, detachAll, listTerminals, writeToTerminal, resizeTerminal, closeTerminal } from './terminal-manager.ts';
import { getTabState, setTabState } from './tab-store.ts';
import { transcribeAudio } from './transcribe.ts';

let wss: WebSocketServer | null = null;

export function setWss(server: WebSocketServer): void {
  wss = server;
}

function broadcastAll(msg: ServerMessage): void {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(data);
    }
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
    console.log(`[ws] ← ${msg.type}`, msg.type === 'agent.audio' ? `(${msg.data?.length} bytes)` : '');
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
      const agentId = createAgentProcess(ws, msg.folder, msg.agentType);
      if (agentId) {
        // Add tab for the new agent
        const tabState = getTabState(msg.folder);
        const tabId = `tab-${agentId}`;
        const label = `${msg.agentType} — ${agentId.slice(6, 18)}`;
        const newTabs = [...tabState.tabs, { kind: 'agent' as const, id: tabId, label, agentId }];
        setTabState(msg.folder, newTabs, tabId);
        broadcastAll({ type: 'tabs.state', folder: msg.folder, tabs: newTabs, activeTabId: tabId });
      }
      break;
    }

    case 'agent.list': {
      listAgentsInFolder(ws, msg.folder);
      const tabState = getTabState(msg.folder);
      send(ws, { type: 'tabs.state', folder: msg.folder, tabs: tabState.tabs, activeTabId: tabState.activeTabId });
      // Auto-send history for all agents in this folder
      for (const tab of tabState.tabs) {
        if (tab.kind === 'agent' && tab.agentId) {
          getAgentHistory(ws, tab.agentId, undefined, 500);
          subscribeToAgent(ws, tab.agentId);
        }
      }
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
      attachTerminal(ws, terminalId);
      send(ws, { type: 'terminal.created', terminalId });
      // Add tab for the new terminal
      const tabState = getTabState(msg.folder);
      const tabId = `tab-${terminalId}`;
      const label = `Terminal — ${terminalId.slice(5, 13)}`;
      const newTabs = [...tabState.tabs, { kind: 'terminal' as const, id: tabId, label, terminalId }];
      setTabState(msg.folder, newTabs, tabId);
      broadcastAll({ type: 'tabs.state', folder: msg.folder, tabs: newTabs, activeTabId: tabId });
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

    case 'tabs.update': {
      const oldState = getTabState(msg.folder);
      const newTabIds = new Set(msg.tabs.map(t => t.id));

      // Clean up removed tabs
      for (const oldTab of oldState.tabs) {
        if (!newTabIds.has(oldTab.id)) {
          if (oldTab.kind === 'agent' && oldTab.agentId) {
            deleteAgent(ws, oldTab.agentId);
          } else if (oldTab.kind === 'terminal' && oldTab.terminalId) {
            closeTerminal(oldTab.terminalId);
          }
        }
      }

      setTabState(msg.folder, msg.tabs, msg.activeTabId);
      broadcastAll({ type: 'tabs.state', folder: msg.folder, tabs: msg.tabs, activeTabId: msg.activeTabId });
      break;
    }

    case 'config.set_preference': {
      setConfigPreference(msg.agentType, msg.configId, msg.value);
      break;
    }

    case 'agent.audio': {
      console.log(`[audio] received audio for agent ${msg.agentId}, mimeType=${msg.mimeType}, data length=${msg.data?.length}`);
      const agentInfo = getAgent(msg.agentId);
      if (!agentInfo) { sendError(ws, `Agent ${msg.agentId} not found`); break; }

      // TODO: If agent natively supports audio (promptCapabilities.audio), forward as audio content block.
      // For now, all agents get transcription since no ACP agent supports native audio yet.

      // Build conversation context for better transcription accuracy
      const history = getHistory(msg.agentId, 20);
      const contextParts: string[] = [];
      for (const entry of history.entries) {
        const p = entry.payload as any;
        if (p.method === 'session/prompt' && p.params?.prompt) {
          const text = Array.isArray(p.params.prompt)
            ? p.params.prompt.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
            : '';
          if (text) contextParts.push(`User: ${text}`);
        }
        if (p.method === 'session/update' && p.params?.update?.sessionUpdate === 'agent_message_chunk') {
          const text = p.params.update.content?.text;
          if (text) contextParts.push(`Agent: ${text}`);
        }
      }
      const context = contextParts.slice(-10).join('\n');

      try {
        console.log(`[audio] calling Gemini transcription...`);
        const text = await transcribeAudio(msg.data, msg.mimeType, context);
        console.log(`[audio] transcription result: ${text.slice(0, 100)}`);
        send(ws, { type: 'agent.audio.transcription' as any, agentId: msg.agentId, text });
      } catch (err) {
        sendError(ws, `Transcription failed: ${err}`);
      }
      break;
    }

    default: {
      sendError(ws, `Unknown message type: ${(msg as any).type}`);
    }
  }
}
