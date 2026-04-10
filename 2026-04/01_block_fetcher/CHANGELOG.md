# Changelog

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
