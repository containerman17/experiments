# SlimNode

API service that manages multiple Avalanche nodes with automatic subnet registration and scaling.

## Features

- Automatic subnet scaling across multiple nodes
- Node pooling with 1 subnet per node by default  
- Automatic container management via Docker
- Rate limiting (2 req/sec per IP)
- Cloudflare tunnel support

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

The server will automatically start Docker containers for nodes based on your configuration.

## API Endpoints

### Scale Subnet

```
GET /node_admin/subnets/scale/:subnetId/:count?password=<admin_password>
```

Scales a subnet to run on specified number of nodes (0-5).

Example:
```bash
curl "http://localhost:3000/node_admin/subnets/scale/FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1/3?password=test123"
```

### Get Subnet Status

```
GET /node_admin/subnets/status/:subnetId?password=<admin_password>
```

Returns node information for a subnet.

Example:
```bash
curl "http://localhost:3000/node_admin/subnets/status/FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1?password=test123"
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

## Architecture

- **API**: Runs on port 3000 with automatic Docker container management
- **Bootnode**: Dedicated bootstrap node on ports 9650/9651
- **Subnet Nodes**: Start from ports 9652/9653 onwards
- **Database**: JSON file storage with automatic backups

## Docker Management

The API automatically manages Docker containers:
- Generates `compose.yml` based on subnet assignments
- Starts containers on API startup
- Restarts containers when subnet assignments change
- Fast bootstrap by copying bootnode data to new nodes

## Rate Limiting

All endpoints are rate limited to 2 requests/second per IP with 5-token burst allowance.

## Development

```bash
# Development mode
npm run dev

# View logs
docker logs bootnode
docker logs node_0000
```