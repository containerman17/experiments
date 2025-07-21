# SlimNode Implementation Plan

This app is completely implemented by AI. Feel free to fix any errors, and do refactors. You have to describe every single endpoint you use in readme.

## Overview
Build an API service that manages multiple Avalanche nodes, each hosting up to 16 subnets, with automatic subnet registration, load balancing, and proxy routing.

## Key Architecture Decisions
- **Hardcoded Configuration**: Port (3000) and Avalanche RPC URL (http://node001:9650) are hardcoded - no unnecessary environment variables
- **Only Meaningful Variables**: ADMIN_PASSWORD, NODE_COUNT, CLOUDFLARE_TUNNEL_TOKEN - things users actually need to configure
- **TASK.md Compliance**: All original requirements fully implemented including bootstrap error const + TODO, docker restart, and precise validation

## TASK.md Requirements Checklist ✅

**Code Style**:
- ✅ TypeScript only, light comments, files 50-200 lines, functions over objects

**API**:
- ✅ `/node_admin/registerSubnet/:subnetId?password=abc` endpoint
- ✅ Idempotent operations (checks if subnet already registered)
- ✅ Password protection for entire `/node_admin/` path

**Validation**:
- ✅ Uses `platform.getSubnet` - checks both `data.result` AND `!data.error`
- ✅ No cache for validation (only for chainId lookups)

**Database**:
- ✅ Exact structure: `{"node001": {"subnetId": timestamp}}`
- ✅ NODE_COUNT environment variable (max 999)
- ✅ 3-digit node format (node001, node002, etc.)
- ✅ Empty objects initialized for all nodes on startup

**Proxy**:
- ✅ `/ext/bc/:chainId/rpc` endpoint
- ✅ Uses `platform.getTx` to get subnetID from chainID
- ✅ 10-minute cache for chainId→subnetId lookups
- ✅ Bootstrap error message as const with TODO comment
- ✅ Proper error handling for connection refused

**Infrastructure**:
- ✅ Rate limiting: 2 req/sec with burst allowance
- ✅ Cloudflare IP detection for rate limiting
- ✅ Docker compose generation with proper ports (9650/9651 + 2 per node)
- ✅ AVAGO_TRACK_SUBNETS with alphabetically sorted subnets
- ✅ `docker compose up -d` call after database changes
- ✅ Cloudflare tunnel in compose

**Documentation**:
- ✅ Comprehensive README with user examples
- ✅ Cloudflare setup instructions

## Core Components

### 1. API Server
- **Framework**: Fastify (TypeScript)
- **Port**: Hardcoded to 3000 (internal Docker container port)
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
2. Check if subnet exists via hardcoded node001 (`platform.getSubnet` - both result AND no error)
3. Check if subnet already registered (idempotent)
4. Find node with lowest subnet count
5. If all nodes full (16 subnets each):
   - Find oldest subnet across all nodes
   - Replace with new subnet
6. Update database and regenerate docker-compose.yml
7. Execute `docker compose up -d` to restart containers

### 4. Proxy Service
1. Extract chainId from request path
2. Query hardcoded node001 to get subnetId via `platform.getTx` (cache 10 min)
3. Look up which node hosts this subnet
4. Forward request or return 404
5. Handle bootstrap errors using const message with TODO comment

### 5. Rate Limiting
- 2 requests/second per IP (from Cloudflare headers)
- Implement burst allowance or queue
- Apply to all endpoints

### 6. Docker Management
- Generate docker-compose.yml dynamically
- Node ports: 9650/9651 for node001, +2 for each additional
- AVAGO_TRACK_SUBNETS env var: alphabetically sorted subnet list
- Include Cloudflare tunnel service
- Execute `docker compose up -d` after any database change

### 7. Environment Configuration
- `.env` file (minimal and meaningful):
  - `ADMIN_PASSWORD` - Static API password (required)
  - `NODE_COUNT` - Number of nodes (optional, default 3, max 999)
  - `CLOUDFLARE_TUNNEL_TOKEN` - Tunnel token (optional)

## Implementation Status - COMPLETED ✅

1. Basic API server with authentication [Implemented]
2. Database initialization and management [Implemented]
3. Subnet validation and registration endpoint [Implemented]
   - Uses `platform.getSubnet` API via hardcoded node001
   - Validates both result AND no error field as per TASK.md
   - Handles node assignment and subnet replacement when full
4. Docker compose generation [Implemented]
   - Dynamically generates docker-compose.yml
   - Assigns incremental ports to nodes
   - Sets AVAGO_TRACK_SUBNETS environment variable
   - Executes `docker compose up -d` after changes
5. Proxy endpoint with caching [Implemented]
   - Uses `platform.getTx` to map chainId → subnetId via hardcoded node001
   - Routes requests to correct node based on subnet assignment
   - Handles connection errors and bootstrap states with const + TODO
6. Rate limiting [Implemented]
   - 2 req/sec per IP with 5-token burst allowance
   - Uses Cloudflare headers for real IP detection
   - Returns 429 with Retry-After header
7. Error handling and logging [Implemented]
   - Uses Fastify's built-in logger + console.log
   - Comprehensive error handling throughout
   - Bootstrap error message as const with TODO comment
8. Cloudflare tunnel integration [Implemented]
   - Added to docker-compose.yml with proper dependencies
   - Environment variable configuration
9. Docker containerization [Implemented]
   - Dockerfile with tsx for zero-build execution
   - Updated compose.yml with SlimNode API service
   - Added `depends_on: node001` to ensure proper startup order
10. Documentation [Implemented]
    - Comprehensive README with all endpoints
    - Usage examples and configuration guide
    - Simplified environment variables
11. Configuration cleanup [Implemented]
    - Hardcoded PORT=3000 (no env var needed)
    - Hardcoded AVALANCHE_RPC_URL=http://node001:9650
    - Only meaningful environment variables remain
12. TASK.md compliance gaps [Fixed]
    - Added bootstrap error const with TODO comment
    - Added `docker compose up -d` execution after database changes
    - Fixed subnet validation to check both result AND no error
    - Fixed syntax error in proxy error handling

## Key Features Delivered

✅ **Complete API Implementation**
- Admin endpoints with password protection
- Subnet registration with validation via local node001
- Status endpoint for monitoring
- Proxy routing for RPC requests

✅ **Smart Node Management**
- Automatic load balancing across nodes
- Oldest subnet replacement when full
- Real-time docker-compose.yml generation
- Automatic container restart after changes

✅ **Production Ready**
- Rate limiting with burst support
- Comprehensive error handling
- Cloudflare tunnel integration
- Docker containerization with proper dependencies

✅ **Clean Configuration**
- No unnecessary environment variables
- Hardcoded sensible defaults for Docker container
- Only user-configurable options exposed

✅ **Local Infrastructure**
- All Avalanche API calls routed through local node001
- No dependency on external Avalanche APIs
- Proper Docker service dependencies

✅ **TASK.md Compliance**
- Every requirement from original specification implemented
- Bootstrap error const with TODO comment
- Docker restart automation
- Precise subnet validation logic

✅ **Developer Experience**
- Zero-build TypeScript execution with tsx
- Hot reload development mode
- Comprehensive documentation
- Clean, minimal codebase (all files under 200 lines)

## Project Structure

```
slimnode/
├── src/
│   ├── server.ts           # Main API server (130 lines) - bootstrap const + TODO
│   ├── database.ts         # Node/subnet management (103 lines)
│   ├── avalanche.ts        # Avalanche API client (75 lines) - precise validation
│   ├── docker-composer.ts  # Docker compose generator (95 lines) - docker restart
│   └── rate-limiter.ts     # Rate limiting logic (55 lines)
├── Dockerfile              # Container build
├── compose.yml             # Docker compose - no PORT/RPC_URL env vars
├── package.json            # Dependencies and scripts
├── README.md              # Complete documentation - simplified env vars
├── PLAN.md                # This implementation plan
├── .env                   # Environment configuration (3 variables only)
└── .env.example           # Example configuration (3 variables only)
```

**Total LOC**: ~458 lines across 5 TypeScript files
**Average file size**: ~92 lines
**All files under 200 lines as required** ✅
**Environment Variables**: Only 3 meaningful ones ✅
**TASK.md Requirements**: 100% complete ✅

## Final Status

🎉 **PROJECT COMPLETED** - All requirements from TASK.md have been implemented and tested. The SlimNode API is production-ready with full subnet management, proxy routing, rate limiting, and Cloudflare tunnel integration. **Every single requirement from the original TASK.md specification is now implemented**, including the specific details like bootstrap error const with TODO comment, docker restart automation, and precise validation logic.
