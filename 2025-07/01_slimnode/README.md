# SlimNode - Avalanche Subnet Node Manager

SlimNode is a high-performance API service that manages multiple Avalanche nodes with intelligent subnet distribution, automatic load balancing, and seamless proxy routing. Each node can host up to 16 subnets with automatic rebalancing based on usage patterns.

## Features

- **Automatic Subnet Management**: Register subnets via simple API calls with intelligent node selection
- **Load Balancing**: Distributes subnets evenly across nodes, replacing oldest subnets when at capacity
- **Smart Proxy**: Routes blockchain requests to the correct node based on chain ID
- **Rate Limiting**: Built-in protection with 2 req/sec per IP with burst support
- **Docker Integration**: Automatic Docker Compose generation and management
- **Cloudflare Tunnel**: Secure public access without exposing ports
- **Real-time Validation**: Verifies subnet existence before registration
- **Idempotent Operations**: Safe to retry any API call

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 24+ (for local development)
- Cloudflare account (for tunnel setup)

### Installation

1. Download the docker-compose.yml file:
```bash
curl -O https://raw.githubusercontent.com/your-org/slimnode/main/docker-compose.yml
```

2. Create your `.env` file in the same directory:
```env
# API Configuration
ADMIN_PASSWORD=your-secure-password-here
NODE_COUNT=5

# Cloudflare Tunnel
TUNNEL_TOKEN=your-cloudflare-tunnel-token

# Avalanche RPC (optional, defaults to public endpoint)
AVALANCHE_RPC_URL=https://api.avax.network/ext/bc/P
```

3. Start the services:
```bash
docker-compose up -d
```

The API will be available at `http://localhost:3000` and through your Cloudflare tunnel domain.

> **Note**: The SlimNode API image is available on Docker Hub as `slimnode/api:latest`

## API Reference

### Register Subnet

Registers a subnet to be tracked by the node cluster. Automatically handles node selection and rebalancing.

```bash
POST /node_admin/registerSubnet/:subnetId?password=your-password

# Example
curl -X POST "http://localhost:3000/node_admin/registerSubnet/FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1?password=your-password"
```

**Response:**
```json
{
  "success": true,
  "node": "node001",
  "message": "Subnet registered successfully"
}
```

### Proxy Requests

Route blockchain RPC requests to the appropriate node hosting the subnet.

```bash
POST /ext/bc/:chainId/rpc

# Example
curl -X POST http://localhost:3000/ext/bc/98qnjenm7MBd8G2cPZoRvZrgJC33JGSAAKghsQ6eojbLCeRNp/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_blockNumber",
    "params": [],
    "id": 1
  }'
```

**Error Response (subnet not tracked):**
```json
{
  "error": {
    "code": 404,
    "message": "This subnet is not tracked by any node"
  }
}
```

## Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ADMIN_PASSWORD` | Password for admin endpoints | - | Yes |
| `NODE_COUNT` | Number of nodes to manage (1-999) | 1 | No |
| `TUNNEL_TOKEN` | Cloudflare tunnel token | - | Yes |
| `AVALANCHE_RPC_URL` | Avalanche P-Chain RPC endpoint | https://api.avax.network/ext/bc/P | No |
| `PORT` | API server port | 3000 | No |
| `DB_PATH` | Path to database file | ./data/nodes.json | No |

### Rate Limiting

The API implements intelligent rate limiting:
- **Limit**: 2 requests per second per IP
- **Burst**: Allows short bursts up to 10 requests
- **Queue**: Excess requests are queued rather than rejected
- **IP Detection**: Uses Cloudflare headers (CF-Connecting-IP) when available

### Docker Compose Management

SlimNode automatically generates and updates `docker-compose.yml` when subnets are added or removed. Each node is configured with:

- Sequential port allocation (9650/9651 for node001, +2 for each additional)
- `AVAGO_TRACK_SUBNETS` environment variable with comma-separated subnet IDs
- Automatic container naming and networking

Example generated configuration:
```yaml
services:
  slimnode-api:
    image: slimnode/api:latest
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      - ./data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - avalanche

  cloudflare-tunnel:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    environment:
      - TUNNEL_TOKEN=${TUNNEL_TOKEN}
    networks:
      - avalanche

  node001:
    image: avaplatform/avalanchego:latest
    ports:
      - "9650:9650"
      - "9651:9651"
    environment:
      - AVAGO_TRACK_SUBNETS=subnet1,subnet2,subnet3
    networks:
      - avalanche

  node002:
    image: avaplatform/avalanchego:latest
    ports:
      - "9652:9650"
      - "9653:9651"
    environment:
      - AVAGO_TRACK_SUBNETS=subnet4,subnet5
    networks:
      - avalanche
```

## Architecture

### Database Structure

SlimNode uses a simple JSON database for tracking subnet assignments:

```json
{
  "node001": {
    "FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1": 1753101451446,
    "2F8j9Rf7E3qPbPXYGNwNkNBkkhpA8Hc7J8FSZZ8L8dv8mRQXQF": 1753101451000
  },
  "node002": {
    "98qnjenm7MBd8G2cPZoRvZrgJC33JGSAAKghsQ6eojbLCeRNp": 1753101452000
  }
}
```

### Subnet Registration Flow

1. **Authentication**: Validates admin password
2. **Subnet Validation**: Checks if subnet exists on Avalanche network
3. **Duplicate Check**: Ensures subnet isn't already registered
4. **Node Selection**: Finds node with lowest subnet count
5. **Capacity Management**: If all nodes full, replaces oldest subnet
6. **Docker Update**: Regenerates compose file and restarts affected containers

### Proxy Caching

The proxy service implements intelligent caching:
- Chain ID to Subnet ID mappings cached for 10 minutes
- Failed lookups cached to prevent repeated API calls
- Memory-based cache with automatic expiration

## Monitoring

### Health Check

```bash
GET /health

# Response
{
  "status": "healthy",
  "nodes": 5,
  "totalSubnets": 42,
  "uptime": 3600
}
```

### Metrics

The application exposes metrics at `/metrics` including:
- Request rates per endpoint
- Cache hit/miss ratios
- Node subnet distribution
- Docker container status

## Cloudflare Tunnel Setup

1. Create a tunnel in Cloudflare dashboard
2. Copy the tunnel token
3. Add to `.env` file
4. The tunnel container will automatically connect

Your API will be available at: `https://your-tunnel.cloudflareaccess.com`

### Local Setup

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run tests
npm test

# Build Docker image locally
docker build -t slimnode/api:local .

# Push to Docker Hub (maintainers only)
docker push slimnode/api:latest
```

### Project Structure

```
slimnode/
├── src/
│   ├── server.ts         # Main API server
│   ├── routes.ts         # Route handlers
│   ├── database.ts       # Database management
│   ├── docker.ts         # Docker compose generation
│   ├── proxy.ts          # Proxy service
│   └── rateLimit.ts      # Rate limiting middleware
├── data/
│   └── nodes.json        # Subnet database
├── docker-compose.yml    # Generated automatically
├── Dockerfile
└── .env                  # Configuration
```

## Troubleshooting

### Common Issues

**Subnet registration fails**
- Verify subnet exists: Check the subnet ID is valid on Avalanche network
- Check authentication: Ensure password is correct
- Review logs: `docker logs slimnode-api`

**Proxy returns 404**
- Subnet may not be tracked: Register it first
- Chain ID might be invalid: Verify on Avalanche explorer
- Cache might be stale: Wait 10 minutes or restart API

**Rate limit errors**
- Reduce request frequency
- Check if behind proxy: Ensure Cloudflare headers are passed
- Implement client-side retry with exponential backoff

## Security Considerations

- Always use HTTPS in production (handled by Cloudflare tunnel)
- Rotate admin password regularly
- Keep node ports (965X) behind firewall, only expose through API
- Monitor for unusual subnet registration patterns
- Regular backups of `nodes.json` database

## Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request
