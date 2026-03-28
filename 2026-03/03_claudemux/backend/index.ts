import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'));

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '../frontend/src/types.ts';
import * as tm from './terminal-manager.ts';
import * as tun from './tunnel-manager.ts';
import * as fm from './file-manager.ts';
import { transcribe } from './voice.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 7938;
const STATIC_DIR = resolve(__dirname, '..', 'frontend', 'dist');

// Persist token so it survives restarts
const CONF_PATH = join(homedir(), '.claudemux.conf');
function loadConf(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(CONF_PATH, 'utf-8')); } catch { return {}; }
}
function saveConf(conf: Record<string, unknown>): void {
  writeFileSync(CONF_PATH, JSON.stringify(conf, null, 2) + '\n');
}
const conf = loadConf();
const token = (typeof conf.token === 'string' && conf.token) ? conf.token : randomBytes(16).toString('hex');
if (conf.token !== token) { conf.token = token; saveConf(conf); }
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
      console.log(`[ws] voice.transcribe for session "${msg.session}", ${msg.audio.length} chars, autoSend=${msg.autoSend}`);
      const context = tm.getContext(msg.session);
      const session = msg.session;
      const autoSend = msg.autoSend;
      transcribe(msg.audio, msg.mimeType, context)
        .then(text => {
          console.log(`[voice] inserting into "${session}": ${text.slice(0, 50)}...`);
          // Exit copy-mode (scroll) before writing, otherwise text goes to void
          tm.exitCopyMode(session);
          tm.write(session, text);
          if (autoSend) {
            setTimeout(() => {
              tm.sendKeys(session, 'Enter');
            }, 150);
          }
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

// --- Static file serving ---

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
  let filePath = join(STATIC_DIR, reqUrl.pathname === '/' ? 'index.html' : reqUrl.pathname);

  // SPA fallback: if file doesn't exist, serve index.html
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(STATIC_DIR, 'index.html');
  }

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const mime = MIME_TYPES[extname(filePath)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  createReadStream(filePath).pipe(res);
}

// --- HTTP + WebSocket server ---

const server = createServer(serveStatic);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);

  // Only upgrade on /ws path
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const clientToken = url.searchParams.get('token');
  if (clientToken !== token) {
    console.log(`[ws] rejected (bad token): ${req.socket.remoteAddress}`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const addr = req.socket.remoteAddress;
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

server.listen(port, () => {
  console.log(`[claudemux] http://localhost:${port}?token=${token}`);
});

// Broadcast session list changes to all clients every 10s
setInterval(() => {
  const sessions = tm.listSessions();
  const msg: ServerMessage = { type: 'sessions.list', sessions };
  for (const ws of wss.clients) {
    send(ws as WebSocket, msg);
  }
}, 10_000);

process.on('SIGINT', () => {
  tun.closeAllTunnels();
  tm.closeAll();
  wss.close();
  server.close();
  process.exit(0);
});

process.on('exit', () => {
  tun.closeAllTunnels();
});
