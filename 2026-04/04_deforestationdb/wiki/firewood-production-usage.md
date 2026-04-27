# Firewood production usage in coreth / avalanchego

**System**: coreth, subnet-evm, avalanchego (graft layer)
**Last verified**: 2026-04-27

## Summary

Firewood is wired into coreth and subnet-evm as an experimental TrieDB
backend, but the production durability story is "trust the background
persist worker to keep up." There is **no explicit fsync coordination**
between Pebble and Firewood; ordering is purely causal (Pebble write,
then Firewood proposal/commit, then implicit OS flush eventually).

Production runs at:
- `deferred_persistence_commit_count = 1` (hardcoded default in FFI)
- `RootStore` disabled (only enabled in archive mode, which is not the
  C-Chain default)
- `max_revisions` = `StateHistory` config (default 128)

There is **no public `Persist()` / `Flush()` API** in either Firewood
FFI variant. Coreth/subnet-evm do not patch Firewood; they accept the
asymmetry and rely on the persist worker firing fast enough.

The Firewood used in production is `github.com/ava-labs/firewood-go-ethhash/ffi`,
which is a **separate Go package** from the `firewood/ffi/` we read
locally. The Rust crate is the same `firewood` though.

## Evidence

### Where Firewood is wired

- `/home/ubuntu/coreth/triedb/firewood/database.go:80-130` — `New(Config)`
  instantiation. RootStore enabled only when `config.ArchiveMode`
  (line 118-120).
- `/home/ubuntu/subnet-evm/triedb/firewood/database.go:80-130` —
  identical structure.
- `/home/ubuntu/coreth/core/blockchain.go:1223-1231` — block processing:
  Pebble write at 1223-1228 (`rawdb.WriteBlock`, `rawdb.WriteReceipts`,
  `blockBatch.Write()`), then `commitWithSnap()` at 1231 which creates
  in-memory ffi.Proposal.
- `/home/ubuntu/avalanchego/graft/coreth/core/blockchain.go:610-615` —
  block acceptance: `writeBlockAcceptedIndices()` writes tx-lookup
  and acceptor-tip to Pebble, then `bc.stateManager.AcceptTrie(next)`
  triggers `TrieDB.Commit(root, false)` which actually persists the
  proposal in Firewood.

### Production config

- `/home/ubuntu/firewood/ffi/firewood.go:147` — hardcoded default
  `deferredPersistenceCommitCount = 1`.
- `/home/ubuntu/subnet-evm/triedb/firewood/database.go:118-120` —
  RootStore directory is set ONLY when `config.ArchiveMode == true`.
  C-Chain runs in pruning mode → RootStore OFF in production.
- `/home/ubuntu/subnet-evm/core/blockchain.go:249` — `Revisions: uint(c.StateHistory)`,
  defaulting to 128.

### Coordination logic (or lack thereof)

The block-acceptance flow:
1. **Block processing** (line 1223-1228): Pebble writes block + receipts
   via `blockBatch.Write()`. Sync depends on Pebble's `WriteOptions.Sync`.
2. **State commit** (line 1231): `commitWithSnap()` → `statedb.Commit()`
   → `TrieDB.Update()` → in-memory `ffi.Proposal` registered.
3. **Block acceptance** (line 610-615): Pebble writes `acceptorTip`
   marker, then `AcceptTrie()` → `TrieDB.Commit(root, false)` triggers
   Firewood's persist worker.

No explicit fsync between steps 2 and 3. No Pebble.Sync forced before
Firewood persist begins. Background persist worker may write after
acceptor-tip is committed to Pebble.

### "Recovery" comment in tests

`/home/ubuntu/coreth/core/blockchain_test.go:514-515`:
> Firewood passes these tests because lastCommittedHeight always equals
> acceptorTip. This means it will work as long as
> lastAcceptedHeight <= acceptorTip + 2 * commitInterval

The test acknowledges the coupling holds in the happy path. There are
no explicit Pebble↔Firewood crash-recovery tests
(`grep "Firewood.*crash\\|recovery.*Firewood"` returns nothing).

### No explicit Persist/Flush API

- `/home/ubuntu/firewood/ffi/firewood.go:519-529` — `FlushBlockReplay()`
  exists but is for block-replay debugging, not general durability.
- No `Flush()`, `Persist()`, or `Sync()` method exposed via FFI in
  either the local repo or the production-imported variant.

## Implications

For our archive:
- **Production accepts asymmetry risk**, betting that Firewood's
  background persist worker keeps up. We don't have to follow that
  bet — we can instead enforce **per-block Pebble fsync**, which gives
  us a hard guarantee that Pebble-on-disk ≥ Firewood-on-disk.
- The production "shortcut" works because:
  1. Pebble is written before Firewood commit (causal order).
  2. `deferred_persistence_commit_count=1` means persist worker fires
     immediately; one block worth of lag at most.
  3. They don't claim machine-crash safety (per Firewood's own README).
- For our archive, we want stronger guarantees, but we don't need to
  patch Firewood. Pebble fsync per block + causal ordering is enough.
- We do NOT need to enable RootStore. Production doesn't, and RootStore
  is the wrong primitive anyway
  (see `wiki/firewood-persistence-behaviour.md`).

## Caveats

- The Firewood we read locally (`/home/ubuntu/firewood/ffi/`) may differ
  in detail from the production-imported `firewood-go-ethhash/ffi`.
  Worth a sanity check by inspecting the imported version when our
  implementation begins.
- "Pruning mode" means old revisions are dropped. For an archive node
  we'll want history retention, but RootStore archival mode is the
  Firewood-internal way to do that (independent from our durability
  question).
