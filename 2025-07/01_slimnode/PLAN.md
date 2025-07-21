# SlimNode Implementation Plan

## Overview
Build an API service that manages multiple Avalanche nodes, each hosting up to 16 subnets, with automatic subnet registration, load balancing, and proxy routing.

## Core Components

### 1. API Server
- **Framework**: Fastify (TypeScript)
- **Main Endpoints**:
  - `/node_admin/registerSubnet/:subnetId` - Register/update subnet assignment
  - Proxy endpoint: `/ext/bc/:chainId/rpc` - Route to appropriate node

### 2. Database Structure
- In-memory/persistent storage with structure:
  ```json
  {
    "node001": {
      "subnetId1": timestamp,
      "subnetId2": timestamp
    },
    "node002": {}
  }
  ```
- Initialize empty objects for NODE_COUNT nodes on startup
- Node IDs: 3-digit format (001-999)

### 3. Subnet Registration Logic
1. Validate password from query param
2. Check if subnet exists via Avalanche API
3. Check if subnet already registered
4. Find node with lowest subnet count
5. If all nodes full (16 subnets each):
   - Find oldest subnet across all nodes
   - Replace with new subnet
6. Update database and regenerate docker-compose.yml

### 4. Proxy Service
1. Extract chainId from request path
2. Query Avalanche API to get subnetId (cache 10 min)
3. Look up which node hosts this subnet
4. Forward request or return 404
5. Handle bootstrap errors specifically

### 5. Rate Limiting
- 2 requests/second per IP (from Cloudflare headers)
- Implement burst allowance or queue
- Apply to all endpoints

### 6. Docker Management
- Generate docker-compose.yml dynamically
- Node ports: 9650/9651 for node001, +2 for each additional
- AVAGO_TRACK_SUBNETS env var: alphabetically sorted subnet list
- Include Cloudflare tunnel service
- Rebuild on any database change

### 7. Environment Configuration
- `.env` file:
  - `ADMIN_PASSWORD` - Static API password
  - `NODE_COUNT` - Number of nodes (max 999)
  - Cloudflare tunnel credentials

## Implementation Order
1. Basic API server with authentication
2. Database initialization and management
3. Subnet validation and registration endpoint
4. Docker compose generation
5. Proxy endpoint with caching
6. Rate limiting
7. Cloudflare tunnel integration
8. Error handling and logging

## Key Considerations
- Idempotent API operations
- Minimal file sizes (50-200 lines)
- Functional programming preferred
- Light commenting
- Production-ready error handling
