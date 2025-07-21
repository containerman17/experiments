# SlimNode API

An API service that manages multiple Avalanche nodes, each hosting up to 16 subnets, with automatic subnet registration, load balancing, and proxy routing.

## Features

- **Subnet Management**: Automatically assign subnets to nodes with load balancing
- **Dynamic Docker Compose**: Generates docker-compose.yml based on subnet assignments  
- **Proxy Routing**: Routes RPC requests to the correct node based on chainId
- **Rate Limiting**: 2 requests/second per IP with burst allowance
- **Cloudflare Integration**: Built-in tunnel support for public access

## Quick Start

1. **Setup Environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

2. **Start Services**:
   ```bash
   docker-compose up -d
   ```

3. **Register a Subnet**:
   ```bash
   curl -X POST "http://localhost:3000/node_admin/registerSubnet/FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1?password=your_password"
   ```

## Environment Variables

```bash
ADMIN_PASSWORD=your_admin_password_here  # Required: Password for admin endpoints
NODE_COUNT=3                            # Optional: Number of Avalanche nodes (default: 3, max: 999)
CLOUDFLARE_TUNNEL_TOKEN=your_token_here  # Optional: Cloudflare tunnel token
```

## API Endpoints

### Admin Endpoints (Protected)

All `/node_admin/` endpoints require the `password` query parameter.

#### Register Subnet
```http
POST /node_admin/registerSubnet/:subnetId?password=<admin_password>
```

Registers a subnet to be tracked by a node. The API will:
1. Validate the subnet exists on Avalanche network via local node001
2. Find the node with the lowest subnet count
3. If all nodes are full (16 subnets each), replace the oldest subnet
4. Update the database and regenerate docker-compose.yml

**Example**:
```bash
curl -X POST "http://localhost:3000/node_admin/registerSubnet/FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1?password=test123"
```

**Response**:
```json
{
  "success": true,
  "message": "Subnet FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1 registered to node001",
  "nodeId": "node001",
  "replacedSubnet": null,
  "nodeSubnets": ["FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1"]
}
```

#### View Status
```http
GET /node_admin/status?password=<admin_password>
```

Returns the current state of all nodes and their registered subnets.

**Example**:
```bash
curl "http://localhost:3000/node_admin/status?password=test123"
```

**Response**:
```json
{
  "nodes": {
    "node001": {
      "FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1": 1704067200000
    },
    "node002": {},
    "node003": {}
  },
  "nodeCount": 3
}
```

### Public Endpoints

#### Proxy RPC Requests
```http
POST /ext/bc/:chainId/rpc
```

Proxies RPC requests to the appropriate Avalanche node based on the chainId. The API will:
1. Extract chainId from the URL path
2. Look up which subnet this chain belongs to via local node001 (cached for 10 minutes)
3. Find which node hosts that subnet
4. Forward the request to the correct node

**Example**:
```bash
curl -X POST "http://localhost:3000/ext/bc/98qnjenm7MBd8G2cPZoRvZrgJC33JGSAAKghsQ6eojbLCeRNp/rpc" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_getBalance",
    "params": ["0x742d35cc6634c0532925a3b8d8b8e302e3db24c3", "latest"],
    "id": 1
  }'
```

## Rate Limiting

All endpoints are rate limited to **2 requests per second per IP** with a **5-token burst allowance**.

- Uses Cloudflare headers (`CF-Connecting-IP`) when available
- Returns `429 Too Many Requests` when exceeded
- Includes `Retry-After` header with seconds to wait

## Node Management

### Port Allocation

Nodes are assigned ports incrementally:
- `node001`: 9650 (HTTP), 9651 (Staking)  
- `node002`: 9652 (HTTP), 9653 (Staking)
- `node003`: 9654 (HTTP), 9655 (Staking)
- etc.

### Subnet Assignment Logic

1. **New Registration**: Assigns to node with lowest subnet count
2. **Full Capacity**: When all nodes have 16 subnets, replaces the oldest subnet
3. **Load Balancing**: Automatically distributes subnets across available nodes

### Docker Compose Generation

The API automatically generates `docker-compose.yml` when subnets are registered:

```yaml
services:
  node001:
    image: avaplatform/avalanchego:latest
    environment:
      AVAGO_TRACK_SUBNETS: "subnet1,subnet2,subnet3"  # Alphabetically sorted
    ports:
      - "9650:9650"
      - "9651:9651"
```

## Cloudflare Tunnel Setup

1. **Create Tunnel**: 
   ```bash
   cloudflared tunnel create slimnode
   ```

2. **Get Token**:
   ```bash
   cloudflared tunnel token slimnode
   ```

3. **Add to Environment**:
   ```bash
   CLOUDFLARE_TUNNEL_TOKEN=your_token_here
   ```

4. **Configure DNS**: Point your domain to the tunnel in Cloudflare dashboard

## Error Responses

### 401 Unauthorized
```json
{
  "error": "Unauthorized"
}
```

### 404 Not Found
```json
{
  "error": "Subnet FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1 does not exist on Avalanche network"
}
```

### 429 Rate Limited
```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 1
}
```

### 503 Service Unavailable
```json
{
  "error": "Node is not ready or still bootstrapping",
  "chainId": "98qnjenm7MBd8G2cPZoRvZrgJC33JGSAAKghsQ6eojbLCeRNp",
  "retry": true
}
```

## Development

### Running Locally

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

### Building

```bash
# Build for production
npm run build

# Start production server
npm start
```

## Architecture

- **Database**: In-memory storage with node → subnet mapping
- **Validation**: Real-time subnet existence checks via local node001
- **Caching**: 10-minute cache for chainId → subnetId lookups via local node001
- **Proxy**: Direct request forwarding to appropriate node ports
- **Rate Limiting**: Token bucket algorithm with burst allowance

## License

MIT
