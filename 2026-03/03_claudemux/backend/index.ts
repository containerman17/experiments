import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'));

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '../frontend/src/types.ts';
import * as tm from './terminal-manager.ts';
import * as tun from './tunnel-manager.ts';
import * as fm from './file-manager.ts';
import { transcribe } from './voice.ts';

const port = Number(process.env.PORT) || 7938;
const token = randomBytes(16).toString('hex');
// Allow large WS messages (up to 20MB for long voice recordings)
const MAX_PAYLOAD = 20 * 1024 * 1024;

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastTunnels(): void {
  const msg: ServerMessage = { type: 'tunnels.list', tunnels: tun.listTunnels() };
  for (const ws of wss.clients) {
    send(ws as WebSocket, msg);
  }
}

// Broadcast tunnel changes to all clients
tun.onTunnelChange(broadcastTunnels);

function handleMessage(ws: WebSocket, msg: ClientMessage): void {
  switch (msg.type) {
    case 'sessions.list':
      send(ws, { type: 'sessions.list', sessions: tm.listSessions() });
      break;

    case 'terminal.attach':
      if (!tm.attach(ws, msg.session)) {
        send(ws, { type: 'error', message: `Session "${msg.session}" not found` });
      }
      break;

    case 'terminal.detach':
      tm.detach(ws, msg.session);
      break;

    case 'terminal.input':
      if (msg.data.length > 20) console.log(`[ws] terminal.input for "${msg.session}", ${msg.data.length} chars`);
      tm.write(msg.session, msg.data);
      break;

    case 'terminal.resize':
      tm.resize(msg.session, msg.cols, msg.rows);
      break;

    case 'terminal.sendkeys':
      tm.sendKeys(msg.session, msg.keys);
      break;

    case 'terminal.scroll':
      tm.scroll(msg.session, msg.lines);
      break;

    case 'voice.transcribe': {
      console.log(`[ws] voice.transcribe for session "${msg.session}", ${msg.audio.length} chars`);
      const context = tm.getContext(msg.session);
      const session = msg.session;
      transcribe(msg.audio, msg.mimeType, context)
        .then(text => {
          console.log(`[voice] inserting into "${session}": ${text.slice(0, 50)}...`);
          tm.write(session, text);
          setTimeout(() => {
            tm.sendKeys(session, 'Enter');
          }, 150);
          send(ws, { type: 'voice.result', session, text });
        })
        .catch(err => { console.error(`[voice] error:`, err); send(ws, { type: 'voice.error', message: String(err) }); });
      break;
    }

    case 'tunnels.list':
      send(ws, { type: 'tunnels.list', tunnels: tun.listTunnels() });
      break;

    case 'tunnels.create':
      tun.createTunnel(msg.port);
      // Response comes via broadcastTunnels when state changes
      break;

    case 'tunnels.delete':
      tun.deleteTunnel(msg.port);
      break;

    case 'files.list': {
      const dirPath = msg.path;
      fm.listDir(dirPath)
        .then(entries => {
          send(ws, { type: 'files.list', path: dirPath, entries });
          send(ws, { type: 'files.sessionDirs', dirs: fm.getSessionDirs() });
        })
        .catch(err => send(ws, { type: 'files.error', message: String(err) }));
      break;
    }

    case 'files.preview': {
      fm.previewFile(msg.path)
        .then(preview => send(ws, { type: 'files.preview', ...preview }))
        .catch(err => send(ws, { type: 'files.error', message: String(err) }));
      break;
    }

    case 'files.mkdir': {
      const dirPath = msg.path;
      fm.createDir(dirPath)
        .then(() => fm.listDir(dirPath.replace(/\/[^/]+$/, '') || '/'))
        .then(entries => {
          const parent = dirPath.replace(/\/[^/]+$/, '') || '/';
          send(ws, { type: 'files.list', path: parent, entries });
        })
        .catch(err => send(ws, { type: 'files.error', message: String(err) }));
      break;
    }

    case 'files.createSession': {
      try {
        const session = fm.createSession(msg.path);
        send(ws, { type: 'files.sessionCreated', session, path: msg.path });
        // Wait a moment for tmux to register the session, then broadcast
        setTimeout(() => {
          const sessions = tm.listSessions();
          const sessionMsg: ServerMessage = { type: 'sessions.list', sessions };
          for (const client of wss.clients) {
            send(client as WebSocket, sessionMsg);
          }
        }, 500);
      } catch (err) {
        send(ws, { type: 'files.error', message: String(err) });
      }
      break;
    }

    case 'files.upload': {
      const uploadSession = msg.session;
      fm.uploadFile(msg.name, msg.data)
        .then(path => {
          console.log(`[files] uploaded: ${path}`);
          send(ws, { type: 'files.uploaded', session: uploadSession, path });
        })
        .catch(err => send(ws, { type: 'files.error', message: String(err) }));
      break;
    }
  }
}

const wss = new WebSocketServer({ port, maxPayload: MAX_PAYLOAD });

wss.on('connection', (ws, req) => {
  const addr = req.socket.remoteAddress;
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const clientToken = url.searchParams.get('token');

  if (clientToken !== token) {
    console.log(`[ws] rejected (bad token): ${addr}`);
    ws.close(4001, 'Unauthorized');
    return;
  }

  console.log(`[ws] connected: ${addr}`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientMessage;
      handleMessage(ws, msg);
    } catch { /* ignore malformed */ }
  });

  ws.on('close', () => {
    console.log(`[ws] disconnected: ${addr}`);
    tm.detachAll(ws);
  });
});

wss.on('listening', () => {
  console.log(`[claudemux] ws://localhost:${port}?token=${token}`);
});

// Broadcast session list changes to all clients every 10s
setInterval(() => {
  const sessions = tm.listSessions();
  const msg: ServerMessage = { type: 'sessions.list', sessions };
  for (const ws of wss.clients) {
    send(ws as WebSocket, msg);
  }
}, 10_000);

// --- Cloudflare tunnel for the backend itself ---
const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

tunnel.stderr.on('data', (chunk: Buffer) => {
  const line = chunk.toString();
  const match = line.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
  if (match) {
    const tunnelUrl = match[0];
    const wsUrl = tunnelUrl.replace('https://', 'wss://');
    const fullUrl = `${tunnelUrl}?token=${token}`;
    console.log(`[tunnel] ${fullUrl}`);
    console.log(`[tunnel] ws: ${wsUrl}?token=${token}`);
  }
});

tunnel.on('error', (err) => {
  console.error(`[tunnel] failed to start cloudflared: ${err.message}`);
});

process.on('SIGINT', () => {
  tunnel.kill();
  tun.closeAllTunnels();
  tm.closeAll();
  wss.close();
  process.exit(0);
});

process.on('exit', () => {
  tunnel.kill();
  tun.closeAllTunnels();
});
