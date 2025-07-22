# SlimNode API

An API service that manages multiple Avalanche nodes, each hosting up to 16 subnets, with automatic subnet registration, load balancing, and proxy routing.

## Architecture

The SlimNode API runs **outside Docker using pm2** while Avalanche nodes run **inside Docker containers**. This prevents self-restart issues and provides better process management.

- **API**: Runs with pm2 on host (port 3000)
- **Avalanche Nodes**: Run in Docker (ports 9650, 9652, 9654...)
- **Cloudflare Tunnel**: Runs in Docker with `network_mode: host` to access the API

### Network Configuration

The Cloudflare tunnel container uses `network_mode: host` to access the SlimNode API running on the host machine at `localhost:3000`. This allows the tunnel to proxy external traffic to the API without complex Docker networking.

### Docker Container Management

**Important**: The API automatically starts and manages Docker containers:
- **On Startup**: Generates compose.yml and runs `docker compose up -d`
- **On Database Changes**: Regenerates compose file and restarts containers asynchronously with new subnet configurations
- **Async Restart**: Container restarts happen in the background since they take several minutes

## Features

- **Subnet Management**: Automatically assign subnets to nodes with load balancing
- **Dynamic Docker Compose**: Generates compose.yml based on subnet assignments  
- **Proxy Routing**: Routes RPC requests to the correct node based on chainId
- **Rate Limiting**: 2 requests/second per IP with burst allowance
- **Cloudflare Integration**: Built-in tunnel support for public access
- **Automatic Container Management**: Starts containers on API startup and restarts asynchronously on configuration changes
- **Node Information**: Returns NodeID, public key, and proof of possession for assigned nodes

## Quick Start

1. **Setup Environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Start API with PM2** (this will automatically start Docker containers):
   ```bash
   # Install pm2 globally
   npm install -g pm2

   # Start the API (automatically starts containers)
   pm2 start npm --name "slimnode-api" -- start

   # For development
   pm2 start npm --name "slimnode-api-dev" -- run dev

   # Enable persistence across reboots
   pm2 save
   pm2 startup
   ```

4. **Register a Subnet**:
   ```bash
   curl -X POST "http://localhost:3000/node_admin/registerSubnet/FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1?password=your_password"
   ```

## Environment Variables

```bash
ADMIN_PASSWORD=your_admin_password_here  # Required: Password for admin endpoints
NODE_COUNT=3                            # Optional: Number of Avalanche nodes (default: 3, max: 999)
DATA_DIR=./data                         # Optional: Data directory for database storage (default: ./data)
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
1. Validate the subnet exists on Avalanche network via localhost:9650
2. Find the node with the lowest subnet count
3. If all nodes are full (16 subnets each), replace the oldest subnet
4. **Fetch node information (NodeID, publicKey, proofOfPossession) before making changes**
5. Update the database and regenerate compose.yml
6. **Return response immediately with node info**
7. **Restart Docker containers asynchronously in the background**

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
  "nodeSubnets": ["FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1"],
  "nodeInfo": {
    "nodeID": "NodeID-LSaQisuyTXKQV9mdifzFpejY4wm1noUWh",
    "publicKey": "0x89beabf01f01940d534cfc3de2e7012f1ffbac562d441ebd23ca4f59f376b1cb8e236eb37307d3ae1621191a661c1ad4",
    "proofOfPossession": "0xb0da9747653498dfb6c829a363c778fe90ac948d04efb9a2605b777db6f9695b7a21bba820b47510c511ef7f2d782c42048872c450ba010bf3a51e960952dfa92c0f9c4274fb8ce8eab4bf1dc919027eca5ec4d80595e8480e75be12400fefef"
  },
  "restartPending": true
}
```

**Note**: The `restartPending: true` field indicates that containers will restart in the background. This process takes several minutes.

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
2. Look up which subnet this chain belongs to via localhost:9650 (cached for 10 minutes)
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

## Process Management

### PM2 Commands

```bash
# Start the API (automatically starts containers)
pm2 start npm --name "slimnode-api" -- start

# Start development mode
pm2 start npm --name "slimnode-api-dev" -- run dev

# Monitor processes
pm2 status
pm2 logs slimnode-api

# Restart the API
pm2 restart slimnode-api

# Stop the API
pm2 stop slimnode-api

# Remove from PM2
pm2 delete slimnode-api

# Save PM2 configuration (persist across reboots)
pm2 save

# Setup PM2 startup (run on boot)
pm2 startup
```

### Docker Commands

```bash
# View logs (containers are managed automatically by API)
docker logs node001
docker logs tunnel

# Manual container management (not normally needed)
docker-compose down  # Stop all containers
docker-compose up -d # Start all containers
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
4. **Node Info**: Fetches and caches node information before any changes

### Docker Compose Generation

The API automatically generates `compose.yml` when subnets are registered and restarts containers asynchronously:

```yaml
services:
  node001:
    image: avaplatform/avalanchego:latest
    environment:
      AVAGO_TRACK_SUBNETS: "subnet1,subnet2,subnet3"  # Alphabetically sorted
    ports:
      - "9650:9650"
      - "9651:9651"
  tunnel:
    image: cloudflare/cloudflared:latest
    network_mode: host  # Access API on host:3000
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

5. **Configure Tunnel Route**: Set tunnel to route traffic to `localhost:3000` (the API running with pm2)

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

# Start development server (automatically starts containers)
npm run dev

# Or with PM2 for development
pm2 start npm --name "slimnode-api-dev" -- run dev
```

### Building

```bash
# Build for production
npm run build

# Start production server
npm start
```

## Data Persistence & Recovery

The SlimNode API uses a robust dual-file backup system to protect against data loss:

### Backup System
- **Primary**: `./data/chains.json` - Main database file
- **Backup**: `./data/chains.backup.json` - Automatic backup copy
- **Process**: Every save writes to both files sequentially

### Recovery Process
1. **Normal Start**: Loads from `chains.json`
2. **Corruption Recovery**: If main file is corrupted, automatically recovers from `chains.backup.json`
3. **Automatic Restore**: Corrupted main file gets restored from backup
4. **Manual Recovery**: If both files fail, you can manually restore from backup

### Manual Recovery
If you need to manually restore from backup:
```bash
# Copy backup to main file
cp ./data/chains.backup.json ./data/chains.json

# Restart the API
pm2 restart slimnode-api
```

## Architecture

- **Database**: Persistent JSON storage at `${DATA_DIR}/chains.json` with automatic backup to `chains.backup.json`
- **Validation**: Real-time subnet existence checks via localhost:9650
- **Node Info**: Permanent caching of node information (NodeID, publicKey, proofOfPossession)
- **Caching**: 10-minute cache for chainId → subnetId lookups
- **Proxy**: Direct request forwarding to appropriate node ports
- **Rate Limiting**: Token bucket algorithm with burst allowance
- **Deployment**: API with pm2 (host) + Avalanche nodes with Docker
- **Tunnel**: Cloudflare tunnel uses host network to access API
- **Container Management**: Automatic Docker container startup and async restart

## License

MIT
