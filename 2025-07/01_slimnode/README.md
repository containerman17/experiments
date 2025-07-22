# SlimNode API

SlimNode manages a set of Avalanche nodes and exposes a small HTTP API. The API runs on port 3000 (outside Docker) and controls Docker containers for a bootnode and multiple subnet nodes.

## Setup

1. `npm install`
2. create `.env` based on `.env.example`
3. start with pm2: `pm2 start npm --name slimnode-api -- start`

The server will create `${DATA_DIR:-./data}/chains.json` and `chains.backup.json` to store subnet assignments.

## Environment variables

- `ADMIN_PASSWORD` – password for all `/node_admin/` calls
- `NODE_COUNT` – number of subnet nodes (default `3`, max `999`)
- `CLOUDFLARE_TUNNEL_TOKEN` – optional; enables a tunnel container
- `BOOTNODE_ID` and `MY_IP` – optional; allow subnet nodes to bootstrap from the bootnode
- `DATA_DIR` – optional data directory

## How it works

On startup the API adjusts the database for `NODE_COUNT` nodes, generates `compose.yml` and runs `docker compose up -d --remove-orphans`. When the bootnode has finished bootstrapping its data is copied to new nodes for faster sync.

Each subnet node tracks up to **16 subnets**. When registering a new subnet the API finds the node with the fewest subnets, or replaces the oldest subnet if all nodes are full. After every change containers are recreated via Docker Compose.

`platform.getSubnet` is called on `localhost:9650` to verify the subnet exists. Chain‑ID lookups are cached for 10 minutes using `platform.getTx`. Node information (`info.getNodeID`) is permanently cached per port.

## Endpoints

All responses are JSON unless stated.

### `POST /node_admin/registerSubnet/:subnetId?password=...`
Assigns a subnet to a node after validation and returns that node's info. Triggers a `docker compose up -d` if this is a new assignment.

### `GET /node_admin/status?password=...`
Returns the current database state.

### `GET /ext/bc/:chainId/rpc`
Quick health check for a chain. Returns `503` with message `"Node is not ready or still bootstrapping"` while the node is unavailable.

### `POST /ext/bc/:chainId/rpc`
Proxies RPC requests to the node hosting the chain. Returns `503` with the same message if the node port refuses the connection.

Rate limiting (2 req/s with a 5‑token burst) is applied per IP. Real IP is extracted from Cloudflare headers when available.

## Docker layout

- `bootnode` runs on ports 9650/9651 and never hosts subnets
- subnet nodes are named `node001`, `node002`, ... using ports 9652+, two ports each
- a `tunnel` service is added when `CLOUDFLARE_TUNNEL_TOKEN` is set

`compose.yml` is regenerated whenever the database changes.

## License

MIT
