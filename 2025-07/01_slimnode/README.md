# SlimNode

API service that manages multiple Avalanche nodes with automatic subnet
registration and explicit node assignment.

## Features

- Explicit node assignment for subnets (add/remove specific nodes)
- Node pooling with 1 subnet per node by default
- Automatic container management via Docker
- Independent expiration timers per node assignment
- Rate limiting (100 req/minute per IP with @fastify/rate-limit)
- Cloudflare tunnel support
- **OpenAPI 3.0 documentation with Swagger UI**

## Quick Start

1. Copy `.env.example` to `.env` and set your admin password:
   ```bash
   cp .env.example .env
   # Edit .env and set ADMIN_PASSWORD
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run the server:
   ```bash
   npm start
   ```

The server will automatically start Docker containers for nodes based on your
configuration.

## API Endpoints

### Add Node to Subnet

```
POST /node_admin/subnets/add/:subnetId?password=<admin_password>
```

Assigns an available node to the subnet. Returns the assigned node information.

Example:

```bash
curl -X POST "http://localhost:3000/node_admin/subnets/add/FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1?password=test123"
```

Response:

```json
{
  "nodeId": 0,
  "nodeInfo": {
    "nodeID": "NodeID-...",
    "nodePOP": { ... }
  },
  "dateCreated": 1234567890,
  "expiresAt": 1234567890
}
```

### Remove Node from Subnet

```
DELETE /node_admin/subnets/delete/:subnetId/:nodeId?password=<admin_password>
```

Removes a specific node from the subnet.

Example:

```bash
curl -X DELETE "http://localhost:3000/node_admin/subnets/delete/FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1/0?password=test123"
```

Response:

```json
{
  "success": true,
  "message": "Removed node 0 from subnet FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1"
}
```

### Get Subnet Status

```
GET /node_admin/subnets/status/:subnetId?password=<admin_password>
```

Returns detailed information about all nodes assigned to a subnet, including
when each was assigned and when it expires. If no nodes are assigned, returns an
empty nodes array.

Example:

```bash
curl "http://localhost:3000/node_admin/subnets/status/FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1?password=test123"
```

Response:

```json
{
  "subnetId": "FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1",
  "nodes": [
    {
      "nodeId": 0,
      "nodeInfo": {
        "nodeID": "NodeID-...",
        "nodePOP": { ... }
      },
      "dateCreated": 1234567890,
      "expiresAt": 1234567890
    }
  ]
}
```

If no nodes are assigned:

```json
{
  "subnetId": "FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1",
  "nodes": []
}
```

### RPC Proxy

```
GET/POST /ext/bc/:chainId/rpc
```

Proxies RPC requests to the appropriate node based on chain ID.

Example:

```bash
# Check status
curl "http://localhost:3000/ext/bc/98qnjenm7MBd8G2cPZoRvZrgJC33JGSAAKghsQ6eojbLCeRNp/rpc"

# RPC call
curl -X POST "http://localhost:3000/ext/bc/98qnjenm7MBd8G2cPZoRvZrgJC33JGSAAKghsQ6eojbLCeRNp/rpc" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
```

## Environment Variables

- `ADMIN_PASSWORD` - Required: Admin API password
- `NODE_COUNT` - Number of nodes to manage (default: 0)
- `DATA_DIR` - Data directory path (default: ./data)
- `CLOUDFLARE_TUNNEL_TOKEN` - Optional: Cloudflare tunnel token
- `ASSIGNMENT_EXPIRATION_TIME` - Node assignment expiration time (default: 5
  minutes)

## Architecture

- **API**: Runs on port 3000 with automatic Docker container management
- **Bootnode**: Dedicated bootstrap node on ports 9650/9651
- **Subnet Nodes**: Start from ports 9652/9653 onwards
- **Database**: JSON file storage with automatic backups, flat array of node
  assignments

## Docker Management

The API automatically manages Docker containers:

- Generates `compose.yml` based on subnet assignments
- Starts containers on API startup
- Restarts containers when subnet assignments change
- Fast bootstrap by copying bootnode data to new nodes

## Rate Limiting

All endpoints are rate limited to 100 requests per minute per IP address using
the official `@fastify/rate-limit` plugin.

When the rate limit is exceeded, the API returns:

- Status code: `429 Too Many Requests`
- Headers include `x-ratelimit-limit`, `x-ratelimit-remaining`, and
  `retry-after`
- Response body includes when to retry

## Development

```bash
# Development mode
npm run dev

# View logs
docker logs bootnode
docker logs node_0000
```

## API Documentation

The API includes built-in OpenAPI 3.0 documentation with an interactive Swagger
UI.

### Accessing Documentation

- **Swagger UI**: http://localhost:3000/docs
- **OpenAPI JSON**: http://localhost:3000/docs/json
- **OpenAPI YAML**: http://localhost:3000/docs/yaml

### Features

- Interactive API explorer with "Try it out" functionality
- Full request/response schemas
- Authentication support (enter admin password in Swagger UI)
- Organized by tags (admin, proxy)
- Auto-generated from route schemas

### Using Swagger UI

1. Navigate to http://localhost:3000/docs
2. Click "Authorize" button
3. Enter your admin password in the `password` field
4. Click "Authorize" to save
5. Explore and test endpoints directly from the browser
