import dotenv from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
import { WebSocketServer } from 'ws';
import { handleConnection, setWss } from './ws-handler.ts';
import { resurrectAndCleanup } from './terminal-manager.ts';
import { backfillSessionIds } from './db.ts';

process.setMaxListeners(20);

// On startup: resurrect terminals with tabs, kill orphans
resurrectAndCleanup();
// Backfill sessionId for agents that were created before the column existed
backfillSessionIds();

const port = Number(process.env.PORT) || 8080;

const wss = new WebSocketServer({ port });
setWss(wss);

wss.on('connection', (ws, req) => {
  const addr = req.socket.remoteAddress;
  console.log(`[ws] client connected from ${addr}`);
  handleConnection(ws);

  ws.on('close', () => {
    console.log(`[ws] client disconnected: ${addr}`);
  });
});

wss.on('listening', () => {
  console.log(`[agent-ui] WebSocket server listening on ws://localhost:${port} (GEMINI_API_KEY ${process.env.GEMINI_API_KEY ? 'set' : 'NOT set'})`);
});
