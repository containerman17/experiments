// server.ts
import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const PORT = 3092
const JWT_SECRET = "DEVELOPMENT_SECRET_PLEASE_CHANGE_919341";
const MAX_KEYS = 10;

type JwtClaims = { sub: string; email?: string; exp?: number; iat?: number; iss?: string; aud?: string };

type KeyRow = {
    user_id: string;
    email?: string;
    key_id: string;             // first 32 bytes of key (base64url)
    salt: string;               // base64url
    hashed_secret: string;      // base64url(HMAC-SHA256(secret, salt))
    alias: string;
    status: "ACTIVE" | "DELETED";
    product_id: string;         // "default" for mock
    created_at: string;         // ISO
    updated_at: string;         // ISO
};

// In-memory DB: user_id -> KeyRow[]
const db = new Map<string, KeyRow[]>();

// Helpers
const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const hdr = req.header("authorization") || req.header("Authorization");
    if (!hdr || !hdr.startsWith("Bearer ")) {
        return res.status(401).json({ error: "missing_bearer_token" });
    }
    const token = hdr.slice("Bearer ".length);
    try {
        const claims = jwt.verify(token, JWT_SECRET) as JwtClaims;
        if (!claims.sub) return res.status(401).json({ error: "invalid_token_no_sub" });
        (req as any).user = { id: claims.sub, email: claims.email };
        next();
    } catch (e: any) {
        return res.status(401).json({ error: "invalid_token", detail: e?.message });
    }
}

function listKeys(userId: string): KeyRow[] {
    return db.get(userId) || [];
}

function upsert(userId: string, rows: KeyRow[]) {
    db.set(userId, rows);
}

function findById(userId: string, keyId: string) {
    return listKeys(userId).find((k) => k.key_id === keyId && k.status === "ACTIVE");
}

function generateApiKey(): { plaintext: string; keyId: string; secretTail: Buffer } {
    // 64 random bytes -> first 32 bytes = keyId material, last 32 bytes = secret material
    const raw = crypto.randomBytes(64);
    const head = raw.subarray(0, 32);   // keyId material
    const tail = raw.subarray(32, 64);  // secret material
    const keyId = b64url(head);         // stable id string
    const plaintext = `ak_${b64url(raw)}`;
    return { plaintext, keyId, secretTail: tail };
}

function hashSecret(secretTail: Buffer, saltB: Buffer): Buffer {
    // Mock uses HMAC-SHA256(secretTail, salt)
    return crypto.createHmac("sha256", saltB).update(secretTail).digest();
}

// Server
const app = express();
app.use(express.json());
app.use((_, res, next) => {
    // simple CORS for local dev
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    next();
});

// Root documentation
app.get("/", (_req, res) => {
    res.type("text/plain").send(`Mock Glacier Keys API Server

Available endpoints:

Health Check:
  GET /healthz - Server health status

API Key Management (requires Bearer token):
  POST /internal/dt-api-keys - Create new API key (body: { "alias": "string" })
  GET /internal/dt-api-keys - List user's API keys
  GET /internal/dt-api-keys/:id - Get specific API key details
  DELETE /internal/dt-api-keys/:id - Revoke API key

Environment:
  Port: ${PORT}
  Max keys per user: ${MAX_KEYS}
`);
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// POST /internal/dt-api-keys { alias } -> returns with plaintext key once
app.post("/internal/dt-api-keys", requireAuth, (req, res) => {
    const user = (req as any).user as { id: string; email?: string };
    const alias = (req.body?.alias || "").toString().trim();
    if (!alias) return res.status(400).json({ error: "alias_required" });
    if (alias.length > 64) return res.status(400).json({ error: "alias_too_long" });

    const rows = listKeys(user.id).filter((k) => k.status === "ACTIVE");
    if (rows.length >= MAX_KEYS) {
        return res.status(409).json({ error: "key_limit_reached", max: MAX_KEYS });
    }

    const { plaintext, keyId, secretTail } = generateApiKey();
    const salt = crypto.randomBytes(16);
    const hash = hashSecret(secretTail, salt);

    const now = new Date().toISOString();
    const row: KeyRow = {
        user_id: user.id,
        email: user.email,
        key_id: keyId,
        salt: b64url(salt),
        hashed_secret: b64url(hash),
        alias,
        status: "ACTIVE",
        product_id: "default",
        created_at: now,
        updated_at: now,
    };

    upsert(user.id, [...listKeys(user.id), row]);

    // Response spec for create includes plaintext key
    return res.status(201).json({
        keyId: row.key_id,
        alias: row.alias,
        customerId: row.user_id,
        productId: row.product_id,
        key: plaintext,
    });
});

// GET /internal/dt-api-keys -> list keys (no plaintext)
app.get("/internal/dt-api-keys", requireAuth, (req, res) => {
    const user = (req as any).user as { id: string };
    const rows = listKeys(user.id).filter((k) => k.status === "ACTIVE");

    // Spec fields + created_at exposure for UI
    const keys = rows.map((k) => ({
        keyId: k.key_id,
        alias: k.alias,
        customerId: k.user_id,
        productId: k.product_id,
        created_at: k.created_at,
    }));

    return res.json({ keys, maxApiKeysAllowed: MAX_KEYS });
});

// GET /internal/dt-api-keys/:id -> single key (no plaintext)
app.get("/internal/dt-api-keys/:id", requireAuth, (req, res) => {
    const user = (req as any).user as { id: string };
    const keyId = req.params.id;
    const row = findById(user.id, keyId);
    if (!row) return res.status(404).json({ error: "not_found" });

    return res.json({
        keyId: row.key_id,
        alias: row.alias,
        customerId: row.user_id,
        productId: row.product_id,
        created_at: row.created_at,
    });
});

// DELETE /internal/dt-api-keys/:id -> revoke
app.delete("/internal/dt-api-keys/:id", requireAuth, (req, res) => {
    const user = (req as any).user as { id: string };
    const keyId = req.params.id;
    const rows = listKeys(user.id);
    const idx = rows.findIndex((k) => k.key_id === keyId && k.status === "ACTIVE");
    if (idx === -1) return res.status(404).json({ error: "not_found" });

    rows[idx] = { ...rows[idx], status: "DELETED", updated_at: new Date().toISOString() };
    upsert(user.id, rows);
    return res.status(204).send();
});

// Start
app.listen(PORT, "0.0.0.0", () => {
    console.log(`mock glacier keys listening on :${PORT}`);
    console.log(`env: PORT=${PORT} MAX_KEYS=${MAX_KEYS}`);
});