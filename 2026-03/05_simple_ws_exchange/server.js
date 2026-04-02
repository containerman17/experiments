const http = require("http");
const { WebSocketServer } = require("ws");
const { URL } = require("url");

const PORT = process.env.PORT || 8080;
const MAX_MSG_SIZE = 10 * 1024; // 10 KB
const RATE_LIMIT = 10; // messages per second per IP
const RATE_WINDOW = 1000; // 1 second

const rooms = new Map(); // token -> Set<ws>
const rateCounts = new Map(); // ip -> { count, resetAt }

function getIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
}

function checkRate(ip) {
  const now = Date.now();
  let entry = rateCounts.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
    rateCounts.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

const API_DESCRIPTION = `WebSocket Exchange Server

Connect two or more clients to the same token to exchange messages.

WebSocket: ws://HOST/:token
  - Connect to a room identified by :token
  - Any message sent is broadcast to all other clients in the same room
  - Token can be any URL-safe string

Limits:
  - Max message size: 10 KB
  - Max rate: 10 messages/second per IP

Example:
  wscat -c ws://localhost:${PORT}/my-secret-token
`;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(API_DESCRIPTION);
  } else {
    res.writeHead(404);
    res.end("Not found\n");
  }
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_SIZE });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.pathname.slice(1); // strip leading /
  const ip = getIP(req);

  if (!token) {
    ws.close(4000, "Missing token in path");
    return;
  }

  if (!rooms.has(token)) rooms.set(token, new Set());
  const room = rooms.get(token);
  room.add(ws);

  const peers = room.size - 1;
  ws.send(JSON.stringify({ type: "info", peers }));

  // notify others
  for (const peer of room) {
    if (peer !== ws && peer.readyState === 1) {
      peer.send(JSON.stringify({ type: "join", peers: room.size - 1 }));
    }
  }

  ws.on("message", (data) => {
    if (!checkRate(ip)) {
      ws.send(JSON.stringify({ type: "error", message: "Rate limit exceeded" }));
      return;
    }

    const msg = data.toString();
    for (const peer of room) {
      if (peer !== ws && peer.readyState === 1) {
        peer.send(msg);
      }
    }
  });

  ws.on("close", () => {
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(token);
    } else {
      for (const peer of room) {
        if (peer.readyState === 1) {
          peer.send(JSON.stringify({ type: "leave", peers: room.size - 1 }));
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Listening on http://0.0.0.0:${PORT}`);
});
