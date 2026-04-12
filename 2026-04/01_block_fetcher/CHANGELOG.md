# Changelog

## Full-root fallback for batch=50k (2026-04-12)

`ComputeIncrementalStateRoot` still produces wrong hashes for large batches due to storage root dummy propagation + TreeMask degradation. Fix: conditional preservation of storage roots in `flushStateOnly` (only when `acct.Root == zero`, meaning dirty storage) + `ComputeFullStateRoot` fallback when incremental fails.

Fallback scans all HashedAccountState + HashedStorageState from scratch — O(total_state) instead of O(changed). At 1.6M blocks: ~10s per 50k batch. Will grow with state size but keeps sync moving at ~600 blocks/sec.

TODO: fix the incremental path so fallback is never needed.

## Full JSON-RPC Server + Receipt Storage (2026-04-12)

### RPC server (`rpc/` package)
HTTP JSON-RPC 2.0 server on `:9670` (configurable via `--rpc-addr`). Serves on `/ext/bc/C/rpc` and `/`. Supports batch requests.

All 16 methods verified against `api.avax.network`:
- eth_blockNumber, eth_chainId, net_version, web3_clientVersion
- eth_getBlockByNumber, eth_getBlockByHash
- eth_getBalance, eth_getStorageAt, eth_getCode, eth_getTransactionCount
- eth_getTransactionByHash, eth_getTransactionReceipt
- eth_getLogs (10k block range cap, brute-force scan with stored receipts)
- eth_call, eth_estimateGas (full EVM execution against historical state via `statetrie.NewHistoricalDatabase`)
- eth_gasPrice (static 25 nAVAX)

### Receipt storage refactor
Unified logs + receipts into single `ReceiptsByBlock` table (was `LogsByBlock`). Each entry stores per-tx: txHash, status, cumulativeGas, gasUsed, txType, contractAddress, and embedded logs. LZ4 compressed per block. `eth_getTransactionReceipt` reads directly from storage — no re-execution needed.

### eth_call / eth_estimateGas implementation
`rpc/evm.go` — sets up EVM against historical state using `statetrie.NewHistoricalDatabase(db, blockNum)`. Same chain config and block context as the executor. eth_estimateGas uses binary search over gas limit.

### Minor: address checksum casing
Our addresses use EIP-55 mixed-case checksums (via `common.Address.Hex()`), reference nodes return lowercase. Data is identical.

## Log Storage & Indexes Implemented (2026-04-12)

Five new data paths added to the execution/flush loop. All write in the same RW transaction as state changes. Verified with batch=50k, zero mismatches, negligible commit overhead.

- **LogsByBlock**: `blockNum(8) → LZ4(logs)`. Logs captured from `sdb.GetLogs()` after each tx during execution. Stored per block, LZ4 compressed.
- **AddressLogIndex**: `address(20)+maxBlock(8) → roaring bitmap`. Sharded at 50k entries. One bitmap per event-emitting address. Updated per-block (deduplicated within block).
- **TopicLogIndex**: `topic(32)+maxBlock(8) → roaring bitmap`. Same sharding. All topic positions (0-3) in one table. Position-unaware — false positives filtered in memory.
- **TxHashIndex**: `txHash(32) → blockNum(8)+txIndex(2)`. One entry per transaction.
- **BlockHashIndex**: `blockHash(32) → blockNum(8)`. One entry per block. Repurposed existing table (was unused).

Files changed: `store/db.go` (5 new DBIs), `store/logs.go` (new), `statetrie/overlay.go` (AddBlockLogs/AddTxHash/AddBlockHash + flush), `main.go` (capture in executeBlock).

## Log Storage & eth_getLogs Design (2026-04-12)

### Final design: Bitmap indexes + stored logs

Three new MDBX tables:

```
AddressLogIndex:  address(20) + maxBlock(8) → roaring bitmap of block numbers
TopicLogIndex:    topic(32) + maxBlock(8)   → roaring bitmap of block numbers
LogsByBlock:      blockNum(8) → LZ4([txIdx(2) | logIdx(2) | addr(20) | nTopics(1) | topics(0-4×32) | dataLen(2) | data])
```

**AddressLogIndex**: one sharded bitmap per event-emitting address. Same pattern as history index — seal shard at threshold, new shard with sentinel key.

**TopicLogIndex**: one sharded bitmap per unique topic value. All 4 topic positions (0-3) go into the same table — no per-position separation. Position-unaware means false positives when the same 32-byte value appears in different positions (e.g., an address as topic1 in one event and topic2 in another). Acceptable: precise filtering happens in-memory after decompressing matching blocks' logs.

**LogsByBlock**: all logs for a block, LZ4-compressed. Generated during execution at zero extra cost (we already run every tx). Written in the batch flush alongside changesets.

**Query flow**: bitmap lookup per filter field (microseconds) → AND/OR intersect (microseconds) → decompress only matching blocks' logs (few ms) → precise in-memory filtering → return. Single-digit ms for any query with at least one filter.

**Caps**: 10k block range limit per request. Result count cap (10k logs). Both standard across providers.

### Rejected alternatives

**Bloom-filter-only (reth's approach)**: No separate indexes; scan block header blooms for eth_getLogs. Problem: our blocks are stored as opaque blobs, extracting the 256-byte bloom requires full block deserialization. Storing blooms separately (256 bytes × 82M blocks = 21GB) is worse than bitmap indexes that compress to a few GB total and give exact results.

**No log storage, re-execute on demand**: Generate logs by re-executing blocks for every eth_getLogs hit. Too slow — a 10k block scan touching 200 matching blocks means 200 block re-executions.

**Separate per-position topic indexes (Topic0Index, Topic1Index, Topic2Index, Topic3Index)**: Eliminates false positives from position ambiguity. 4x tables and 4x writes during sync. Not worth it — false positive rate is low (event signatures are keccak hashes, won't collide with addresses/uint256s), and in-memory filtering catches everything.

**Inverted index without stored logs**: Bitmaps tell you WHICH blocks, but you still need the actual log data. Without stored logs you'd re-execute matching blocks. Defeats the purpose.

### Receipts

`eth_getTransactionReceipt(txHash)`: re-execute the single block on demand. Receipt fields (`status`, `cumulativeGasUsed`, `effectiveGasPrice`, `logs`, `contractAddress`) are all deterministic from execution. No receipt storage needed.

## 2026-04-12 — Fixed state root mismatch at block 1,562,989

**Three bugs found and fixed** that caused incremental trie computation to produce wrong state roots:

### Bug 1: Stale StorageTrie branch nodes (ROOT CAUSE of block 1,562,989 mismatch)
**File:** `statetrie/incremental.go`
**Problem:** When an account's storage is deleted and later recreated across batches, old branch nodes remain in the `StorageTrie` table even though the account's storage root resets to `emptyRoot`. When `ComputeIncrementalStateRoot` recomputes the storage root for such an account, the walker finds these stale branch nodes and trusts their cached hashes, producing a wrong storage root. At block 1,562,989, contract `0x8d36C5c6` (addrHash `ea901832...`) had 12 stale StorageTrie entries from previous batches, but its old storage root was `emptyRoot` (no storage expected). The walker used 3 of these stale branches, computing root `8cc59aa2...` instead of the correct `6e10f4b3...`.
**Fix:** Before computing the storage root for any account with changed storage, delete ALL existing StorageTrie entries for that account. The incremental computation then starts fresh, and the new branch nodes are written after computation.

### Bug 2: Walker descent frame immediately popped
**File:** `trie/walker.go`
**Problem:** When the `TrieWalker.Advance()` descended into a child subtree (pushing a new frame onto the stack via `break`), the code immediately fell through to `w.stack = w.stack[:len(w.stack)-1]`, popping the just-pushed frame. The child subtree was never processed. This meant subtrees with stored branch nodes (TreeMask=1) that needed re-hashing were silently skipped — their cached hashes from the walker were lost, and ALL their leaves had to come from the leaf source.
**Fix:** Added `descended` flag; when true, `continue` the outer loop instead of popping.

### Bug 3: `deletePrefixedEntries` skipping every other entry
**File:** `statetrie/incremental.go`
**Problem:** After `cursor.Del(0)`, MDBX positions the cursor at the successor entry. The code called `cursor.Get(nil, nil, mdbx.Next)` which advanced AGAIN, skipping every other entry. Only half the entries were deleted.
**Fix:** Changed to `cursor.Get(nil, nil, mdbx.GetCurrent)` after deletion, matching the pattern in `deleteStaleNodes`.

### Verification
- Block 1,562,989 now passes. 136+ consecutive batches (batch=100) verified with zero mismatches past the former stuck point.
- `ComputeFullStateRoot` (from-scratch) always matched expected root, confirming the flat state data was correct all along.
- dRPC endpoint `lb.drpc.live/avalanche/...` confirmed to have archival state at this block (eth_getStorageAt, eth_call work; debug_trace only for recent blocks; eth_getProof limited to 32-block window).

### Batch size increased to 50k (default)
10k → 50k: ~960 blocks/sec vs ~650. Per-batch overhead (hash+commit ~12.5s) amortized over more blocks. Batch timeout now scales with size (2ms per block, min 60s).

### DB backup
`data/mainnet-mdbx/mdbx.dat.bak` — snapshot at head=1,562,988. Restore with `cp mdbx.dat.bak mdbx.dat`.

## Executor Architecture (agreed 2026-04-11)

The executor processes blocks in batches. This is how it SHOULD work:

1. **Take a batch** of N blocks (configurable via `--exec-batch-size`).
2. **Execute in memory** — an overlay accumulates all state changes. Block execution NEVER computes trie hashes. There is no "skip hash" mode because hashing is not a per-block operation.
3. **Capture diffs per block** — changesets (keyID → oldValue) stored for every block, enabling historical state lookups. Keys are compressed via the key dictionary (address+slot → 8-byte keyID).
4. **Flush + incremental hash + verify** — one atomic operation at the batch boundary: flush overlay to MDBX, compute state root via incremental hashing (O(changed_state) using PrefixSet + TrieWalker + NodeIter + HashBuilder), verify against block header, set head block, commit.

Batch size is the ONLY tunable. Every batch is verified. There is no flag controlling "how often to verify" because verification is integral to every batch commit.

### Current state vs target

The code currently has TWO architectures layered on top of each other:

- **Old per-block path**: `AccountTrie.Hash()` / `StorageTrie.Hash()` with `SkipHash` mode toggle, `incrementalHash()` opening its own RW tx, `flushStateOnlyMDBX()` for non-overlay writes, `computeStateRoot()` doing O(total_state) scans, `collectAllAccounts()` for full state enumeration.
- **New batch path**: `ComputeIncrementalStateRoot()` in `statetrie/incremental.go`, overlay-based execution, `FlushStateToTx()`.

### Refactoring plan (one commit per step)

1. ~~Remove `SkipHash` flag from `Database`.~~ **DONE** — `Hash()` always flushes state, never computes trie hash.
2. ~~Remove `AccountTrie.incrementalHash()` and `StorageTrie.incrementalHash()`.~~ **DONE** — ~360 lines removed. All incremental hashing goes through `ComputeIncrementalStateRoot`.
3. ~~Remove `computeStateRoot()` from main.go.~~ **DONE** — ~300 lines removed (function + helper RLP encoders).
4. ~~Remove `collectAllAccounts()`, `flushStateOnlyMDBX()`, etc.~~ **DONE** — ~200 lines removed. `flushStateOnly()` inlined to always use overlay.

**ROOT CAUSE FOUND AND FIXED: Avalanche network upgrades not configured.** 917k blocks verified with zero mismatches after fix. The C-Chain genesis JSON only contains standard Ethereum forks (homestead through muirGlacier). Avalanche-specific upgrades (ApricotPhase1-5, Banff, Cortina, Durango, Etna) were missing, causing ALL blocks to execute with pre-ApricotPhase1 rules. Key differences: (1) gas refunds enabled (should be disabled after AP1 March 2021), (2) no Berlin/London block settings from AP2/AP3, (3) NativeAsset precompiles not activated. Fix: `setAvalancheUpgrades()` reads mainnet timestamps from `upgrade.GetConfig(MainnetID)` and sets them on the chain config extras before `SetEthUpgrades`. Block 867,931 (WAVAX withdraw) was the first block where the gas refund difference produced a visibly different state root. The `isMultiCoin` extra flag on accounts was not stored in our flat state encoding. WAVAX `withdraw()` calls the NativeAssetCall precompile which sets `isMultiCoin=true` on accounts. Our 104-byte account encoding didn't include this flag, so the RLP hash was wrong for any account with multi-coin balances. Fix: expanded account encoding to 105 bytes, `AccountLeafSource` now reads the flag and encodes correct RLP extra field (`0x01` for true, `0x80` for false).

**Previously documented as:** Fails with both batch=1 and batch=1000. Only 3 changed accounts, 1 storage slot — trivial change but wrong root. Branch nodes in MDBX accumulate corruption over ~867k blocks of incremental updates. **Root cause identified: stale branch node accumulation.** `HashBuilder.Updates()` only returns nodes that should exist — it never marks nodes for deletion. When a trie restructures (subtree collapses, children removed), old branch nodes linger in MDBX. The walker finds them on subsequent runs and trusts their cached hashes, but those hashes correspond to a trie structure that no longer exists. Fix needed: track which branch nodes the walker visited and delete any stored nodes NOT in the update set for changed prefixes.

**Fix: skip unchanged branch nodes during persist** — `HashBuilder.Updates()` returns every branch node traversed, not just changed ones. With 544 changed accounts (uniformly distributed by keccak), the walker descends into nearly all branches at the top levels. Was writing 19,864 identical nodes per batch; now compares before writing, only 1,066 actually changed. Prevents massive MDBX commits.

**NEW MISMATCH at block 1,572,000** (in batch 1,562,001-1,572,000). Near ApricotPhase2 activation (NativeAsset precompiles, Berlin fork prep). Investigating.

**Batch size 10,000**: 32% faster than batch=1000. Hash amortized from 10×690ms to ~2s, commit from 10×380ms to ~2s. ~800 blocks/sec at 1.5M blocks.

**Bugfix: storage trie hash was not truly incremental** — `deletePrefixedEntries` was destroying all stored branch nodes before recomputing each account's storage root, forcing a full rebuild every batch. Removed the call; the walker + PrefixSet already handles unchanged subtrees correctly via cached hashes. Hash time dropped from ~700ms to ~100ms per 1000-block batch.
5. ~~Remove `--verify-interval` / rename.~~ **DONE** — single `--exec-batch-size` flag.
6. ~~Clean up `executeBatch`.~~ **DONE** — no SkipHash toggle, no mode flags.

## 2026-04-11 (session 22)

- **100k checkpoint intervals**: Replaced mixed 1k/10k/1M checkpoint grid with uniform 100k intervals (826 entries). Fetcher now creates smaller, more granular jobs so the executor frontier gets fed sooner.
- **godotenv for `.env` loading**: `utils/blockcontainerids/main.go` now loads `.env` automatically via `godotenv.Load()` instead of requiring manual env export.
- **Thorough job skip check**: Replaced endpoint-only heuristic (check toBlock + fromBlock) with cursor-scan that counts every block in the range via `store.CountContainersInRange()`. Old check was hiding massive gaps — e.g. [1800001, 1900000] had 1/100000 blocks but was marked complete.
- **Executor batch timing**: Added exec/hash/flush timing breakdown to `executeBatch` log output.
- **Default verify-interval changed from 0→256**: `--verify-interval=0` meant verify every block, calling O(total_state) `computeStateRoot` per block. At 100k+ blocks this takes minutes per block. Now defaults to 256 (same as writer batch size).
- **Default fetch-workers changed to 32**: Benchmarked 8/16/32 workers over 2-minute runs: 2,769 / 5,084 / 7,308 blocks/sec. Nearly linear scaling with 250+ connected peers.
- **Per-peer in-flight request cap (4)**: Added `peerInflight` tracker so no single peer gets more than 4 concurrent GetAncestors requests. Avalanchego default limit is 1024 concurrent msgs/peer + 512 KiB/sec bandwidth throttle — cap of 4 is conservative. Forces better load distribution: 32 workers with cap = 8,399 blocks/sec (+15% vs uncapped 7,308), because workers spread across more peers instead of piling onto fast ones.
- **INCREMENTAL STATE ROOT HASHING** — replaced O(total_state) `computeStateRoot` with O(changed_state) incremental approach using PrefixSet + TrieWalker + NodeIter + HashBuilder. New `statetrie/incremental.go` with `ComputeIncrementalStateRoot()`.
  - **Algorithm**: At batch end, flush overlay to MDBX, then for each account with changed storage compute its storage root incrementally (only re-hashing changed slots). Fix HashedAccountState entries with correct storage roots (SkipHash writes zeros). Then compute account trie root incrementally. All in one RW transaction with branch node persistence.
  - **Performance**: Hash time is flat ~300ms per 1000-block batch regardless of total state size. At block 100k: 298ms. Previously would have taken minutes with the full scan.
  - **100k blocks verified** in ~42 seconds with 1000-block batches, all roots match.
  - Added `overlay.FlushStateToTx()`, `overlay.ChangedAccountHashes()`, `overlay.ChangedStorageGrouped()`, `ReadOldStorageRoots()`.
  - `executeBatch` restructured: EndBatchRO → read expected root → capture old storage roots → RW tx (flush + incremental hash + verify + set head + commit).

## 2026-04-10 (session 21)

- **Parallel block fetcher**: replaced sequential single-request fetch loop with a job-based parallel fetcher using N concurrent workers (default 8, configurable via `--fetch-workers`).
- **Design**: Embedded checkpoints from `container_ids.json` (85 entries at 1k, 10k, 100k, 1M, 2M, ..., 82M) define block ranges. Each adjacent pair of checkpoints becomes a `fetchJob`. Jobs are sorted by `toBlock` ascending so lowest ranges near the executor frontier are fetched first.
- **Workers**: Each worker pulls the next unstarted job from a shared priority queue, picks a peer via `peerTracker`, and walks backwards via `GetAncestors` from the checkpoint's known container ID. Workers send blocks to the existing `writerCh` channel (thread-safe, writer unchanged).
- **Response demuxing**: Added `routeMap` to `inboundHandler` — each worker registers a per-request response channel before sending, so concurrent `GetAncestors` responses are routed to the correct worker without interference. Unrouted responses still fall through to the shared `ancestorsCh`.
- **Job skipping**: On startup, jobs whose `toBlock` and `fromBlock` are both already in MDBX are skipped (resume support). Partially-fetched jobs restart from the top — `PutContainer` is idempotent, so duplicate writes are harmless.
- **Progress reporting**: Background goroutine logs aggregate fetch rate every 5 seconds. Per-job completion logs include block count, elapsed time, and rate.
- **Rationale**: Sequential fetching at ~300 blocks/sec was the bottleneck vs ~4000 blocks/sec execution. Parallel fetching across 8 peers should approach the aggregate bandwidth of connected validators.
- Added `--fetch-workers=N` flag (default 8).

## 2026-04-11 (session 20)

- **BREAKTHROUGH: Shared RO transaction** — opening one MDBX read-only transaction per batch instead of per-read eliminated the #1 bottleneck. Each `GetAccount`/`GetStorage` was doing a cgo round-trip to open/close a transaction. With 500+ reads per block × 1000 blocks per batch = 500,000 cgo calls eliminated.
- **100k blocks in 41 seconds** (~2400 blocks/sec). Previous best was 14 minutes (119 blocks/sec). **35x improvement** from the session start (44 min dual executor).
- Key insight: the bottleneck was never EVM execution, hashing, or GC — it was MDBX transaction management overhead. Hundreds of thousands of unnecessary cgo calls per batch.
- Progression: 44min → 27min (batch hash) → 14min (batch writes) → 24min (overlay, regression from GC) → **41sec** (shared RO tx).
- Note: 2400 blocks/sec is for early chain (0-100k, sparse blocks). Later blocks with heavy DeFi txs will be much slower. Need to test at 1M+ blocks.
- Bumped tip to 1M blocks for next test.

## 2026-04-10 (session 19)

- **BatchOverlay integration**: rewired executor, account trie, and storage trie to use `BatchOverlay` for batch-oriented execution. During a batch, ALL reads go through overlay->MDBX, ALL writes go to overlay only. Zero MDBX write transactions during execution. One `Flush()` at the end.
- **RawChange type**: changesets accumulated as `(addr, slot, oldValue)` tuples during execution (no keyID assignment needed). KeyIDs assigned in bulk during `Flush()` inside the single RW transaction.
- **Account/Storage trie split**: `flushStateOnly()` now dispatches to `flushStateOnlyOverlay()` (reads old values from overlay->MDBX via RO tx, writes new values to overlay) or `flushStateOnlyMDBX()` (original direct MDBX RW path for non-batch mode).
- **UpdateContractCode**: writes to overlay when active, avoiding per-contract MDBX RW transactions.
- **ContractCode/GetStorage reads**: now check overlay first when in batch mode.
- **computeStateRoot**: accepts overlay parameter, performs sorted merge of overlay + MDBX hashed state for correct root computation.
- **Storage trie Hash()**: now respects `SkipHash` flag (previously always computed full hash even in batch mode).
- **Database.FlushChangeset**: in overlay mode, sends raw changes to overlay instead of opening MDBX RW transaction.

## 2026-04-11 (session 18)

- **Batch-oriented executor**: restructured from per-block to `executeBatch(from, to)`. Executes all blocks with flat state writes only (SkipHash), computes state root once at batch end via `computeStateRoot()`. One code path, no dual-mode flags.
- **Manual RLP encoding**: eliminated `rlp.EncodeToBytes` + `pseudo.From[bool]` allocations for StateAccount. Stack-buffer encoding, 61% fewer total allocations (10.6M → 4.1M/10s).
- **Allocation profile**: key buffer reuse in MDBXLeafSource, manual account RLP → GC pressure significantly reduced.
- **10k benchmark**: batch=1000 runs in 1m23s (120 blocks/sec) vs 1m43s per-block (97 blocks/sec) — 20% faster, gap widens with larger state.
- **Verified through 16k+ blocks** with zero mismatches.
- **TODO**: replace `computeStateRoot` full scan with incremental walker (critical for live mode with large state). Dynamic batch sizing (large when behind, 1 at tip).
- **Research**: investigated Firewood (Ava Labs' Rust flat-state DB) — stores trie nodes at disk offsets, NOT flat state like reth. Archival mode keeps all revisions = even bigger. Our changeset approach is fundamentally more compact.
- **Research**: 5 agents analyzed avalanchego codebase — confirmed `state.Database` replacement requires `triedb.DBOverride` pattern (~2000 lines glue), not a simple interface swap. 14 coupling points identified. P2P state sync needs trie nodes but not serving them doesn't break consensus.

## 2026-04-10 (research)

- Investigated dual-write (trie + flat state) feasibility: traced StateDB.Commit() pipeline, transaction boundary analysis, ethdb.Batch intercept points, write amplification evidence, and changeset capture timing. See report in conversation.

## 2026-04-11 (session 17)

- **Single executor architecture**: One pass does everything — fetch blocks, execute with coreth's state.StateDB, verify state roots via HashBuilder, write flat state + hashed state + changesets + history index. No duplicate execution. No `statetrie_verify` needed.
- **Fixed**: Account/storage Hash() methods use direct HashBuilder scan over keccak-sorted HashedAccountState/HashedStorageState tables. Correct and verified through 100k blocks.
- **Fixed**: HashBuilder branch node persistence — `pushBranchNode` now collects hashes for ALL children (not just those with pre-existing hashMask bits), enabling fresh trie computations to store branch nodes.
- **Fixed**: NodeIter skip logic — when walker yields a cached-hash branch (unchanged subtree), skip all state leaves under that prefix to prevent double-counting. (Walker+nodeiter incremental path still has issues, deferred to future session.)
- Created `cmd/debug_hash/main.go`: diagnostic tool comparing three root computation methods
- **BLOCKER — O(total_state) hashing does not scale to full chain sync.** Current Hash() scans ALL accounts/storage per block via HashedAccountState/HashedStorageState cursor. At ~85 blocks/sec for 100k blocks (small state), this will degrade catastrophically as state grows to millions of accounts. C-Chain has 18M+ blocks and state only gets heavier. Two-week sync target is impossible with O(total_state) — need O(changed_state) via incremental walker+nodeiter.
- **Root cause of walker+nodeiter bug (identified, not yet fixed):** `walker.go:113` — when the walker DESCENDS into a branch node (because PrefixSet says children changed), it yields the branch node as an element via `return childPath, childNode, [32]byte{}, false`. The NodeIter passes this to HashBuilder as `AddBranch()`, which treats it as a pre-computed subtree hash. But it's NOT a complete subtree — it's a signal that "I'm descending, children follow." The fix: descended branches should NOT be yielded as elements. The walker should only yield cached hashes (for unchanged/skipped subtrees). Descended branches just push onto the stack and continue. Leaves come from the flat state via LeafSource.
- **Next step**: Fix walker.Advance() to not yield descended branches. Remove line 113's return. Just push the child frame and `continue` the loop. Then re-test incremental path end-to-end.

## 2026-04-11 (session 16)

- Switched `main.go` executor from ethdb adapter (`mdbxethdb → rawdb → triedb → state.Database`) to `statetrie.Database` backed by flat MDBX state + incremental trie hashing
- Replaced `cChainGenesis.MustCommit(ethDB, trieDB)` with `loadGenesisFlat()` that writes plain AND hashed state tables (AccountState, HashedAccountState, StorageState, HashedStorageState)
- Removed `trieDB.Commit(root, false)` from `executorProcessBlock` — replaced with `stateDB.FlushChangeset(blockNum)` for changeset/history index writes
- Added `loadGenesisFlat()` to `main.go`: idempotent genesis loader with metadata marker, populates all 4 state tables
- Removed unused imports: `rawdb`, `triedb`, `mdbxethdb`; added `statetrie`, `crypto`

## 2026-04-10 (session 15)

- Rewrote `AccountTrie.Hash()` and `StorageTrie.Hash()` to use incremental trie hashing (PrefixSet + TrieWalker + NodeIter + HashBuilder) instead of O(total_state) StackTrie scan
- Hash() now writes dirty state to BOTH plain and hashed tables, runs incremental hash over hashed tables + stored branch nodes, and persists branch node updates to AccountTrie/StorageTrie tables
- Commit() simplified to just return cached root from Hash() and clear dirty state — all real work done in Hash()
- Added `trie.TrieCursor` interface to `trie/walker.go` — abstracts `*mdbx.Cursor` so prefix-stripping adapters can be used
- Created `statetrie/cursor_adapter.go` — `PrefixedTrieCursor` that scopes MDBX cursor to a key prefix (used for per-address StorageTrie table access with `keccak(address)` prefix)
- Created `statetrie/leaf_source.go` — `AccountLeafSource` (transforms raw 104B account bytes to RLP-encoded StateAccount) and `StorageLeafSource` (RLP-encodes trimmed storage values) wrappers for the trie LeafSource interface

## 2026-04-10 (session 14)

- Added `HashedAccountState` and `HashedStorageState` MDBX tables to `store/db.go` — keyed by keccak256 hashes for efficient cursor-based iteration during incremental trie computation
- Added `PutHashedAccount`, `DeleteHashedAccount`, `PutHashedStorage`, `DeleteHashedStorage` functions to `store/state.go`
- Both new tables included in `ClearState()` cleanup
- Refactored `trie/nodeiter.go`: replaced raw `*mdbx.Cursor` + `statePrefix` with a `LeafSource` interface, enabling pluggable leaf sources (e.g., merged overlay of dirty in-memory state on top of MDBX)
- Added `MDBXLeafSource` wrapping an MDBX cursor with prefix scoping for backward compatibility
- Simplified `advanceState()` to delegate cursor logic to the `LeafSource` implementation
- Removed unused `keccak256` helper function

## 2026-04-10 (session 13)

- **Fixed**: `CallContract` now uses real `*state.StateDB` backed by `statetrie.NewHistoricalDatabase` instead of custom `historicalState`. This allows `corethcore.RegisterExtras()` to install the `OverrideNewEVMArgs` hook which wraps StateDB with `StateDBAP0` for pre-ApricotPhase1 blocks — fixing `GetCommittedState` behavior needed for correct SSTORE gas refund calculations.
- **Fixed**: Account/storage-slot-0 keyID collision in the key dictionary. Account entries now use `AccountSentinelSlot` (all `0xFF`) instead of zero slot, preventing `LookupHistoricalStorage(slot=0)` from returning account data (104-byte nonce+balance+codeHash+storageRoot) as a storage value.
- Lightnode `registerExtras()` now registers all 4 libevm extras (matching `evm.RegisterAllLibEVMExtras()`): `corethcore.RegisterExtras`, `ccustomtypes.Register`, `extstate.RegisterExtras`, `cparams.RegisterExtras`
- **All 1000 blocks pass**: 804 transaction replays (eth_call at block N-1), 10 static checks, 0 mismatches

## 2026-04-10 (session 12)

- Added `lightnode.BlockByNumber` — returns full parsed block (ethclient-compatible)
- Added `lightnode.TransactionByHash` stub (needs tx index for O(1) lookup)
- Implemented real `getHash` function for BLOCKHASH opcode (reads block hashes from stored containers)
- Added transaction replay testing to `cmd/lightnode_test/main.go`: replays actual block transactions as `eth_call` on block N-1 state, comparing local `lightnode.Node.CallContract()` results against archival RPC
- Test exits on first mismatch for easier debugging
- Static tests (balance, storage, WAVAX name/symbol/decimals): all pass
- **Known bug**: block 23 tx 0 — our EVM reverts but archival RPC returns success (`0x`). Contract `0x640440c1` (231 storage slots) called with selector `0x63615149`. Same full calldata, same block 22 state, different result. Root cause: likely incorrect historical storage values for this contract at block 22, or missing precompile behavior. The contract code exists (5443 bytes), sender has balance, but execution reverts in our EVM. Needs investigation of specific storage slot values vs what the archival node has.

## 2026-04-10 (session 11)

- Created `lightnode/` package: embeddable API matching `ethclient.Client` method signatures
- `lightnode/node.go`: `Node` struct with `New(Config)`, `Close()`, `BlockNumber`, `BalanceAt`, `NonceAt`, `CodeAt`, `StorageAt`, `HeaderByNumber`, `CallContract`
- `lightnode/historical_state.go`: read-only `vm.StateDB` implementation backed by `store.LookupHistorical*` functions for historical EVM execution
- `CallContract` builds a full EVM with historical state, supports `eth_call` against any past block
- All read methods use MDBX RO transactions with proper `runtime.LockOSThread`
- Created `cmd/lightnode_test/main.go`: validation tool comparing `BalanceAt`, `StorageAt`, and `CallContract` results against Avalanche archival RPC

## 2026-04-10 (session 10)

- **Fixed**: `UpdateHistoryIndex` bitmap corruption bug — cursor-returned key/value slices point to MDBX memory-mapped pages; subsequent `tx.Put` calls invalidated that memory, causing seeks for other keyIDs to find wrong entries or miss existing sentinels entirely. Fix: copy cursor-returned `k` and `v` to owned byte slices before any write operations.
- Test result: 90/90 eth_call checks now pass (up from 82/90)

## 2026-04-10 (session 9)

- Added historical state lookup functions to `store/history.go`: `LookupHistoricalAccount`, `LookupHistoricalStorage` — retrieve account/storage values at any past block number using changeset + roaring bitmap history index
- Algorithm: find earliest changeset after target block that touched the key, return the old value from that changeset; if no later changeset exists, current flat state is still valid
- Pre-history check: if queried block is before the first-ever change, return genesis/pre-creation value from the first changeset's oldValue
- Created `cmd/eth_call_test/main.go`: validation tool comparing historical balances/nonces/storage against Avalanche archival RPC (`api.avax.network`)
- Test result: 82/90 checks pass. WAVAX contract verified: name="Wrapped AVAX", symbol="WAVAX", decimals=18
- **Known bug (fixed in session 10)**: `store.UpdateHistoryIndex` roaring bitmap loses entries from early blocks when later blocks are processed

## 2026-04-10 (session 8)

- Wired changeset writing, key dictionary, and history index into custom state trie commit path
- Added `AppendChanges` and `FlushChangeset` to `statetrie/database.go` — accumulates changes from both account and storage tries, writes combined per-block changeset + history index in a single RW transaction
- Modified `AccountTrie.Commit()` to read old account values from MDBX before overwriting, assign keyIDs via `store.GetOrAssignKeyID`, and append `store.Change` entries to the Database accumulator
- Modified `StorageTrie.Commit()` to read old storage slot values from MDBX before overwriting, assign keyIDs, and append changes to the Database accumulator
- Added `store.EncodeAccountBytes()` helper for serializing accounts to changeset old-values
- Updated `cmd/statetrie_verify/main.go` to call `FlushChangeset(blockNum)` after each block commit
- Verified: all 1000 blocks still pass with changeset collection enabled

## 2026-04-10 (session 7)

- Created `statetrie/` package implementing `state.Database` and `state.Trie` interfaces backed by flat MDBX storage
- `statetrie/database.go`: `Database` struct with `OpenTrie`, `OpenStorageTrie`, `CopyTrie`, `ContractCode`, `ContractCodeSize`, `DiskDB`, `TrieDB`
- `statetrie/account_trie.go`: `AccountTrie` implementing `state.Trie` for the account trie — reads from MDBX `AccountState`, dirty overlay, `Hash()` via `StackTrie` (O(total_state) scan), `Commit()` flushes to MDBX
- `statetrie/storage_trie.go`: `StorageTrie` implementing `state.Trie` for per-account storage tries — reads from MDBX `StorageState`, dirty overlay, `Hash()` via `StackTrie`, `Commit()` flushes to MDBX

## 2026-04-10 (session 6)

- Restructured block storage to use container ID as primary key: replaced `Blocks` (number → raw) and `BlockIndex` (hash → number) tables with `Containers` (containerID → raw) and `ContainerIndex` (blockNumber → containerID)
- New functions: `PutContainer`, `GetContainer`, `GetContainerByNumber`, `HasContainer`
- Kept `GetBlockByNumber` as a deprecated wrapper around `GetContainerByNumber` for backward compatibility

## 2026-04-10 (session 5)

- Replaced broken custom `executor.NewExecutor` in `main.go:runExecutor` with coreth-native state processing (matching the proven `cmd/coreth_verify/main.go` approach)
- Uses `rawdb.NewDatabase` + `triedb.NewDatabase` + `state.NewDatabaseWithNodeDB` backed by MDBX ethdb adapter
- Processes blocks with `corethcore.ApplyMessage`, atomic txs via `extstate.New(sdb)`, `sdb.Finalise(true)`, `sdb.IntermediateRoot(true)`, and `sdb.Commit` + `trieDB.Commit`
- Added missing `cparams.SetEthUpgrades(chainCfg)` call and full coreth extras registration (`corethcore.RegisterExtras`, `extstate.RegisterExtras`)
- Supports resume: reads head block from Metadata, loads parent state root from committed block header
- Removed dependency on `block_fetcher/executor` package from main.go

## 2026-04-10 (session 4)

- Added `TableEthDB` table to `store/db.go` with DBI field, Open assignment, Env() accessor, and ClearState cleanup
- Created `store/ethdb/` package implementing `ethdb.KeyValueStore` backed by MDBX: `mdbxkv.go` (Database with Has/Get/Put/Delete), `batch.go` (in-memory buffered batch with single-txn Write), `iterator.go` (cursor-based prefix iterator with RO txn), `snapshot.go` (MVCC snapshot via RO txn)
- All byte slices properly copied from mmap'd memory before txn abort
- Switched `cmd/coreth_verify/main.go` from in-memory database to MDBX-backed ethdb adapter, so trie/state data persists across runs
- Added `--clean-ethdb` flag to clear the EthDB table before running (useful for re-execution from genesis)
- Added timing output: prints elapsed time and blocks/second at completion

## 2026-04-10 (session 3)

- Created `cmd/coreth_verify/main.go`: uses real coreth/libevm code (state.StateDB, ApplyMessage, Finalise, IntermediateRoot) to process C-Chain blocks and verify state roots against block headers, using an in-memory trie database seeded from genesis
- **All 1000 blocks verified successfully** with coreth's real state processing — 6 seconds total
- Key insight: our custom executor/statedb/trie had subtle encoding differences that are eliminated by using coreth's actual code. Next step: replace custom executor with coreth's real state.StateDB backed by MDBX

## 2026-04-10 (session 2)

- Fixed storage value encoding in `trie/stateroot.go`: removed double-RLP encoding of storage values in `computeAllStorageRoots`. Values from MDBX are already trimmed bytes; passing them through `rlp.EncodeToBytes()` before `AddLeaf()` double-encoded them since the HashBuilder's leaf node encoder also RLP-string-encodes the value.
- Added EIP-161 empty account cleanup in `executor/executor.go:applyAccountChange`: accounts with zero balance, zero nonce, and emptyCodeHash are deleted instead of persisted. The EVM "touches" precompile addresses during CALL, creating empty state entries that geth's `Finalise(true)` removes.
- Created `cmd/debug_root/main.go`: tool comparing geth's trie, our HashBuilder, and `ComputeStateRoot` on the same MDBX flat state — confirmed all three agree
- Created `trie/stateroot_test.go`: test comparing our HashBuilder vs geth's trie for block 19 data — confirmed trie implementations match
- Removed `mdbx.SafeNoSync` flag from `store/db.go` to allow cross-process DB reads for debugging
- Confirmed: flat state at block 19 matches archival RPC (`api.avax.network`) exactly for all 11 accounts and 6 storage slots
- Confirmed: libevm `isMultiCoin` Extra field IS included in account RLP for all blocks (via `ccustomtypes.Register()`)
- Block 19 state root investigation ongoing — trie and flat state verified correct, encoding matches geth, root mismatch persists

## 2026-04-10 (session 1)

- Created `cmd/debug_block19/main.go`: debug tool comparing local DB state at block 19 against archival RPC
- Added atomic transaction processing to `executor/executor.go`: cross-chain imports/exports applied after EVM execution
- Fixed account RLP encoding in `trie/stateroot.go`: use full StateAccount encoding (not slim)
- Fixed nil BaseFee/Difficulty panics in `executor/blockctx.go` for pre-EIP-1559 blocks
- Added `runtime.LockOSThread` for MDBX thread safety in writer and executor
- Added `--clean-state` flag to clear state tables while keeping fetched blocks
- Hardcoded public node URI (`api.avax.network`) for peer discovery
- Genesis root verified matching ✓, blocks 1-18 pass (atomic imports working)
- Block 19 (first contract creation) has state root mismatch — storage encoding investigation needed

- Created `storage_design.md`: full storage architecture with MDBX, key dictionary (30/34 bit split), ZSTD-compressed changesets, roaring bitmap history index
- Created `trie_verification.md`: reth-style incremental trie verification using prefix sets, dual-cursor walks, and HashBuilder
- Deleted `trie_storage.md`: replaced by the above two docs
- Created `docs/01_historical_state_plan.md`: implementation plan for MDBX-backed historical state storage, executor, and verification test
- Created `store/db.go`: MDBX wrapper with 12 named tables, Open/BeginRO/BeginRW/Close
- Created `store/keys.go`: key encoding helpers (BlockKey, StorageKey, HistoryKey, KeyID 30/34 split)
- Created `store/blocks.go`: block storage and metadata CRUD
- Created `store/state.go`: flat state CRUD (accounts, code, storage slots)
- Created `store/keydict.go`: key dictionary with sequential addressID/slotID assignment
- Created `store/history.go`: ZSTD-compressed changesets, roaring bitmap history index with sharding
- Created `executor/statedb.go`: vm.StateDB backed by MDBX with memory overlay and journal-based snapshot/revert
- Created `executor/genesis.go`: C-Chain genesis loading from AvalancheGo config
- Created `executor/blockctx.go`: EVM block context construction with Shanghai/Avalanche handling
- Created `executor/executor.go`: main block execution loop — parse, execute txs, write state + changesets + history
- Created `trie/nibbles.go`: nibble path encoding for MPT keys
- Created `trie/prefixset.go`: sorted prefix set with cursor optimization (reth port)
- Created `trie/branchnode.go`: BranchNodeCompact encoding/decoding (reth format)
- Created `trie/hashbuilder.go`: streaming MPT hash builder with tests (alloy_trie port)
- Created `trie/walker.go`: trie node walker with PrefixSet-based skip/descend
- Created `trie/nodeiter.go`: dual-cursor merge of trie nodes + flat state
- Created `trie/stateroot.go`: top-level state root computation (simple O(state) version for bootstrap)
- Created `trie/walker.go`: trie node walker with PrefixSet-based skip/descend
- Created `trie/nodeiter.go`: dual-cursor merge of trie nodes + flat state
- Added trie verification to `executor/executor.go`: computes and validates stateRoot every block
- Rewrote `main.go`: replaced PebbleDB with MDBX, added executor goroutine
- Created `cmd/verify_history/main.go`: test tool comparing local historical state vs archival RPC
- Hardcoded public node URI (`api.avax.network`) for peer discovery
- Fixed nil BaseFee/Difficulty panics in blockctx.go for pre-EIP-1559 blocks
- Simplified executor loop: poll for next block, sleep 100ms if missing
- First test run: 1002 containers fetched in ~74s, state root mismatch at block 1 (missing block finalization/rewards)
