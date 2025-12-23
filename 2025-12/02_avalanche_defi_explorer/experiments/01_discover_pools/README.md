so @pkg/poolsdb/PoolsManager.ts does pool discovery and cache busting. instead I want pool discovery to be a separate process that runs periodically and dumps pools into a file.

File format should be a simple semicolon separated data. address:providerName:poolType:token1:token2:token3... 

No more storage in the database. 

@pkg/poolsdb/PoolsDB.ts does not need any live functionality or cache busting anymore. 

Also create @pkg/providers/index.ts exporting all providers as an array of PoolProvider objects. 

@experiments/02_pool_explorer/backend/index.ts does not need a PoolDB - it can just do the event processing in the while (true). For each of the providers call the processLogs method and then call cache bust in @pkg/poolsdb/DollarPriceStream.ts

---

## Implementation Plan

### 1. Create standalone pool discovery script
- [x] Create `experiments/01_discover_pools/discover.ts`
- [x] Script should run periodically and discover pools
- [x] Output pools to `experiments/01_discover_pools/pools.txt` in semicolon-separated format
  - Format: `address:providerName:poolType:token1:token2:token3...`
- [x] Use existing PoolsManager logic but adapted for file output instead of DB

### 2. Create pkg/providers/index.ts
- [x] Export all providers as an array of PoolProvider objects
- [x] Import all provider files (uniswap_v3, algebra, lfj_v1, lfj_v2, etc.)
- [x] Create single export array containing all provider instances

### 3. Simplify PoolsDB.ts
- [x] Remove live functionality and cache busting
- [x] Keep only basic pool storage/retrieval if needed
- [x] No longer needs real-time updates

### 4. Update experiment 02 backend
- [x] Remove PoolDB dependency
- [x] Implement event processing directly in while(true) loop
- [x] For each provider, call processLogs method
- [x] Call cache bust in DollarPriceStream after processing
