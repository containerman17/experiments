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
    console.log("🔐 Auth Debug - Raw Authorization header:", hdr ? `"${hdr.substring(0, 50)}..."` : "MISSING");

    if (!hdr || !hdr.startsWith("Bearer ")) {
        console.log("❌ Auth Error: Missing or invalid Bearer token format");
        return res.status(401).json({ error: "missing_bearer_token" });
    }

    const token = hdr.slice("Bearer ".length);
    console.log("🎫 Auth Debug - Extracted token:", token);
    console.log("🎫 Auth Debug - Extracted token length:", token.length);
    console.log("🎫 Auth Debug - Token starts with:", token.substring(0, 20) + "...");
    console.log("🔑 Auth Debug - JWT_SECRET being used:", JWT_SECRET);

    try {
        console.log("🔍 Auth Debug - Attempting JWT verification...");
        const claims = jwt.verify(token, JWT_SECRET) as JwtClaims;
        console.log("✅ Auth Debug - JWT verified successfully! Claims:", JSON.stringify(claims, null, 2));

        if (!claims.sub) {
            console.log("❌ Auth Error: No 'sub' claim found in JWT");
            return res.status(401).json({ error: "invalid_token_no_sub" });
        }

        console.log("👤 Auth Debug - User authenticated:", { id: claims.sub, email: claims.email });
        (req as any).user = { id: claims.sub, email: claims.email };
        next();
    } catch (e: any) {
        console.log("❌ Auth Error - JWT verification failed:");
        console.log("   Error type:", e.constructor.name);
        console.log("   Error message:", e.message);
        console.log("   Stack trace:", e.stack);
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
app.use((req, res, next) => {
    // Full CORS support for mock server
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Origin, X-Requested-With");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
    res.header("Access-Control-Allow-Credentials", "false");
    res.header("Access-Control-Max-Age", "86400");

    // Handle preflight requests
    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    next();
});

// Root documentation
app.get("/", (_req, res) => {
    res.type("text/plain").send(`Mock Glacier API - Dev Console API Key Management

================================================================================================
AUTHENTICATION
================================================================================================
All API key management endpoints require JWT Bearer token authentication.

Header format:
  Authorization: Bearer <JWT_TOKEN>

JWT must be issued by BuildersHub and contain:
  - sub: User ID (required)
  - email: User email (optional)
  - exp: Expiry timestamp
  - iat: Issued at timestamp

Example:
  curl -H "Authorization: Bearer eyJhbGciOiJI..." https://api.example.com/internal/dt-api-keys

================================================================================================
ENDPOINTS
================================================================================================

----------------------------------------
1. CREATE API KEY
----------------------------------------
POST /internal/dt-api-keys
Creates a new API key for the authenticated user.

Request Headers:
  Authorization: Bearer <JWT_TOKEN>

Request Body:
  {
    "alias": "string"  // Required, max 64 characters, descriptive name for the key
  }

Success Response (201):
  {
    "keyId": "string",        // Unique identifier (first 32 bytes of key)
    "alias": "string",        // The alias provided
    "customerId": "string",   // User ID from JWT sub claim
    "productId": "string",    // Product identifier
    "key": "string"           // ACTUAL API KEY - ONLY RETURNED ONCE! Format: ak_<base64>
  }

Error Responses:
  400: { "error": "alias_required" }      // No alias provided
  400: { "error": "alias_too_long" }      // Alias exceeds 64 characters
  401: { "error": "missing_bearer_token" } // No auth header
  401: { "error": "invalid_token" }       // JWT verification failed
  409: { "error": "key_limit_reached", "max": ${MAX_KEYS} } // User has max keys

Example:
  curl -X POST https://api.example.com/internal/dt-api-keys \\
    -H "Authorization: Bearer <JWT>" \\
    -H "Content-Type: application/json" \\
    -d '{"alias": "Production Key"}'

----------------------------------------
2. LIST API KEYS
----------------------------------------
GET /internal/dt-api-keys
Lists all active API keys for the authenticated user.

Request Headers:
  Authorization: Bearer <JWT_TOKEN>

Success Response (200):
  {
    "keys": [
      {
        "keyId": "string",      // Unique identifier
        "alias": "string",      // Descriptive name
        "customerId": "string", // User ID
        "productId": "string"   // Product identifier
      },
      // ... more keys
    ],
    "maxApiKeysAllowed": number  // Maximum keys allowed per user (currently ${MAX_KEYS})
  }

Error Responses:
  401: { "error": "missing_bearer_token" }
  401: { "error": "invalid_token" }

Example:
  curl https://api.example.com/internal/dt-api-keys \\
    -H "Authorization: Bearer <JWT>"

----------------------------------------
3. GET SINGLE API KEY
----------------------------------------
GET /internal/dt-api-keys:keyId
Gets details of a specific API key.

Request Headers:
  Authorization: Bearer <JWT_TOKEN>

URL Parameters:
  keyId: The key identifier to retrieve

Success Response (200):
  {
    "keyId": "string",        // Unique identifier
    "alias": "string",        // Descriptive name
    "customerId": "string",   // User ID
    "productId": "string"     // Product identifier
  }

Error Responses:
  401: { "error": "missing_bearer_token" }
  401: { "error": "invalid_token" }
  404: { "error": "not_found" }  // Key doesn't exist or belongs to another user

Example:
  curl https://api.example.com/internal/dt-api-keys:abc123def456 \\
    -H "Authorization: Bearer <JWT>"

----------------------------------------
4. DELETE (REVOKE) API KEY
----------------------------------------
DELETE /internal/dt-api-keys:keyId
Revokes an API key, marking it as deleted.

Request Headers:
  Authorization: Bearer <JWT_TOKEN>

URL Parameters:
  keyId: The key identifier to delete

Success Response: 204 No Content

Error Responses:
  401: { "error": "missing_bearer_token" }
  401: { "error": "invalid_token" }
  404: { "error": "not_found" }  // Key doesn't exist or belongs to another user

Example:
  curl -X DELETE https://api.example.com/internal/dt-api-keys:abc123def456 \\
    -H "Authorization: Bearer <JWT>"

================================================================================================
HEALTH CHECK
================================================================================================

GET /healthz
Returns server health status (no authentication required).

Response (200):
  {
    "ok": true
  }

================================================================================================
API KEY SECURITY
================================================================================================

- API keys are 64 bytes, base64-encoded with 'ak_' prefix
- First 32 bytes serve as the key_id for fast lookup
- Last 32 bytes are the secret, stored as HMAC-SHA256 hash with salt
- Keys are NEVER stored in plaintext
- Keys are returned in plaintext ONLY ONCE during creation
- Lost keys cannot be recovered - users must create new ones

Storage Schema:
  - user_id: User ID from JWT
  - email: Optional email from JWT
  - key_id: First 32 bytes for lookup
  - salt: Random salt for hashing
  - hashed_secret: HMAC-SHA256(secret, salt)
  - alias: User-provided name
  - status: ACTIVE or DELETED
  - created_at/updated_at: Timestamps

================================================================================================
CURRENT CONFIGURATION
================================================================================================

Server Port: ${PORT}
Max API Keys Per User: ${MAX_KEYS}
Environment: Development (Mock Server)
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

    // Spec fields only (no created_at per spec)
    const keys = rows.map((k) => ({
        keyId: k.key_id,
        alias: k.alias,
        customerId: k.user_id,
        productId: k.product_id,
    }));

    return res.json({ keys, maxApiKeysAllowed: MAX_KEYS });
});

// GET /internal/dt-api-keys:keyId -> single key (no plaintext)
app.get(/^\/internal\/dt-api-keys:(.+)$/, requireAuth, (req, res) => {
    const user = (req as any).user as { id: string };
    const keyId = req.params[0];
    const row = findById(user.id, keyId);
    if (!row) return res.status(404).json({ error: "not_found" });

    return res.json({
        keyId: row.key_id,
        alias: row.alias,
        customerId: row.user_id,
        productId: row.product_id,
    });
});

// DELETE /internal/dt-api-keys:keyId -> revoke
app.delete(/^\/internal\/dt-api-keys:(.+)$/, requireAuth, (req, res) => {
    const user = (req as any).user as { id: string };
    const keyId = req.params[0];
    const rows = listKeys(user.id);
    const idx = rows.findIndex((k) => k.key_id === keyId && k.status === "ACTIVE");
    if (idx === -1) {
        console.log("❌ 404 Error - Key not found:", { userId: user.id, keyId, method: "DELETE" });
        return res.status(404).json({ error: "not_found" });
    }

    rows[idx] = { ...rows[idx], status: "DELETED", updated_at: new Date().toISOString() };
    upsert(user.id, rows);

    // Return success JSON instead of 204 No Content
    return res.status(200).json({
        success: true,
        message: "API key revoked successfully"
    });
});

// Catch-all 404 handler - logs all unmatched routes
app.use((req, res) => {
    console.log("❌ 404 Error - Route not found:", {
        method: req.method,
        url: req.url,
        path: req.path,
        headers: {
            authorization: req.header("authorization") ? "Bearer [REDACTED]" : "None",
            "content-type": req.header("content-type"),
            "user-agent": req.header("user-agent"),
        },
        ip: req.ip,
        timestamp: new Date().toISOString()
    });
    res.status(404).json({ error: "not_found", message: `Route ${req.method} ${req.path} not found` });
});

// Start
app.listen(PORT, "0.0.0.0", () => {
    console.log(`mock glacier keys listening on :${PORT}`);
    console.log(`env: PORT=${PORT} MAX_KEYS=${MAX_KEYS}`);
});