# Pool Explorer (AI Reference)

This sub-project is a real-time DeFi pool price explorer for Avalanche, optimized for rapid development and visibility.

## Technical Architecture

- **Single Process / Shared Port (5173)**: 
  - Backend runs an Express server.
  - Serves `vite` development middleware (`middlewareMode: true`).
  - Native Node `http` server handles both Express (HTTP) and `ws` (WebSocket) on the same port.
  
- **State Synchronization (Snapshot + Patches)**:
  - **Server**: Maintains a `fullState` `Map<string, PoolPriceData>` indexed by `getPriceKey(pool, tokenIn, tokenOut)`.
  - **Connection**: On connection, the client receives the entire `fullState` as a "patch" (snapshot).
  - **Updates**: Ongoing price updates from `DollarPrice.subscribeToPrices` are broadcast as partial patches.
  
- **Data Model (`src/types.ts`)**:
  - Shared `PoolPriceData` interface.
  - `getPriceKey` helper ensures consistent key generation: `${pool}:${tokenIn}:${tokenOut}`.
  
- **Frontend State**:
  - Merges incoming patches into a `Record<string, PoolPriceData>`.
  - Dedupes by `getPriceKey` so history is preserved across updates and token pairs don't overwrite each other.

- **Stack**: React, Tailwind CSS v4, Viem, Express, WS, React-Timeago.

## Features & Implementation Details

- **UI Layout**: Grouped by Provider (e.g., TraderJoe, Uniswap), then tiled per Pool.
- **Quote Display**: Each pool tile lists all quote pairs in the format: `IN => OUT [Rate] / [Inverse]`.
- **Invalidation**: On contract revert/error, the server emits `amountOut: "0"` and the `error`. The UI dims these tiles (opacity 30%) and shows `---` for the rate to indicate data invalidation while keeping the UI stable.
- **Timelining**: Each update has an `updatedAt` timestamp. The UI shows the relative time since the last update for each pool using `react-timeago`.
- **Blockchain Monitoring**: Uses `wsClient.watchBlockNumber` for trigger and `httpClient.getLogs` for batch processing storage changes.

## Evolution of User Requests (Context for AI)

1.  **Cleanup**: Migrated from standard CSS to Tailwind v4.
2.  **WebSockets**: Shifted from console logging to a WebSocket-based real-time feed.
3.  **Port Sharing**: Integrated Vite into the backend to avoid proxying and CORS issues.
4.  **Symbol Enrichment**: Re-engineered backend to fetch symbols/decimals via `cachedRPC` before emitting to client.
5.  **State Persistence**: Implemented server-side `Map` and client-side merging to prevent "waiting" for data on refresh.
6.  **UI Refinement**: Moved from "one tile per quote" to "one tile per pool" with multi-line lists.
7.  **Pricing Format**: Updated to show both normal (`OUT/IN`) and reversed (`IN/OUT`) rates simultaneously.
8.  **Time Tracking**: Added timestamps and `react-timeago` to judge data freshness.

## How to Run

```bash
# High-speed dev loop (TopCoins limited to 100 in backend/index.ts)
npm run dev
```
