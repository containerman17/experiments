import { WebSocketServer } from 'ws';
import { handleConnection, setWss } from './ws-handler.ts';

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
  console.log(`[agent-ui] WebSocket server listening on ws://localhost:${port}`);
});
