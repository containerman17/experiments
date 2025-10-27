### 1. **Updated Reader** (`reader.go`)
- Added a 2000-block circular buffer for recent blocks
- Tracks `firstBlock` and `lastBlock` for efficient range checking  
- `FeedBlock()` method to receive blocks from writer
- `NextBlock()` checks buffer first, then falls back to archive files
- Simple and fast - just checks if block is in range `[firstBlock, lastBlock]`
- **Waiting reader**: If no archive file exists and block not in buffer, waits for block to appear in buffer (waits 10ms and loops)
- Never fails with "file not found" - just waits for writer to fetch and feed the block

### 2. **Created Writer** (`writer.go`) 
- Scans existing zstd files to find latest written block on startup
- Two modes based on distance to chain head:
  - **Fast catch-up** (≥1000 blocks behind): Fetches 1000 blocks in parallel, writes to zstd, feeds to reader buffer
  - **Live following** (<1000 blocks behind): Fetches block-by-block, accumulates, writes at 1000-block boundaries
- Uses the existing `Fetcher` for RPC calls (no go-ethereum dependency)
- Writes blocks to zstd files in the same format reader expects
- Feeds all blocks to reader's buffer immediately for tail reads

### 3. **Updated Main** (`main.go`)
- Wires everything together
- If `RPC_URL` env var is set, starts writer in background
- Reader works with or without writer:
  - With writer: Gets recent blocks from buffer, older from archives
  - Without writer: Just reads from existing archive files
- Optional `INCLUDE_TRACES` env var to enable trace fetching

## How It Works

1. **Startup**: Writer scans existing files, determines where to continue
2. **Fast Mode**: When >1000 blocks behind, fetches entire batches in parallel for speed
3. **Live Mode**: When caught up, fetches one-by-one, pauses 500ms when at head
4. **Buffer**: Reader keeps last 2000 blocks in memory for instant access
5. **Files**: Written every 1000 blocks in zstd format matching reader's expectations

The system handles both initial sync and live following seamlessly, with the reader always able to serve blocks whether from buffer or archives.

---