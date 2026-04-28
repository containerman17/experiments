---
name: bootstrap-local-container-cache
description: Snowman bootstrap checks local VM (ProposerVM container store) before issuing network GetAncestors — orphan containers act as a cache.
type: reference
last_verified: 2026-04-28
---

# Snowman bootstrap uses a local-first container lookup

When the snowman bootstrapper walks ancestors back from the tip, it
checks the local VM first and only goes to the network if the
local lookup fails.

## The local-first loop

From `~/avalanchego/snow/engine/snowman/bootstrap/bootstrapper.go:405-417`:

```go
toProcess := make([]snowman.Block, 0, numMissingBlockIDs)
for blkID := range b.missingBlockIDs {
    blk, err := b.VM.GetBlock(ctx, blkID)
    if err != nil {
        if err := b.fetch(ctx, blkID); err != nil {  // network GetAncestors
            return err
        }
        continue
    }
    toProcess = append(toProcess, blk)  // local hit
}
```

`b.VM` here is the ProposerVM (the consensus engine sees the
ProposerVM as the chain VM). Its `GetBlock` does a plain
container-store lookup:

`~/avalanchego/vms/proposervm/vm.go:368-370` →
`~/avalanchego/vms/proposervm/vm.go:767-771` →
`~/avalanchego/vms/proposervm/vm.go:774-789`:

```go
func (vm *VM) getPostForkBlock(ctx context.Context, blkID ids.ID) (PostForkBlock, error) {
    block, exists := vm.verifiedBlocks[blkID]
    if exists {
        return block, nil
    }
    statelessBlock, err := vm.State.GetBlock(blkID)   // KV lookup in container store
    if err != nil {
        return nil, err
    }
    innerBlkBytes := statelessBlock.Block()           // inner block bytes embedded in container
    innerBlk, err := vm.parseInnerBlock(ctx, blkID, innerBlkBytes)  // parse via inner ChainVM
    ...
}
```

Crucially, `vm.State.GetBlock(blkID)` is just a key lookup in
ProposerVM's container store. It is not gated by the `lastAccepted`
pointer. So even if `repairAcceptedChainByHeight` rolled
`lastAccepted` back to genesis (because the inner VM's standalone
DB was wiped — see `wiki/proposervm-startup-repair.md`), the
container entries for blocks `1..tip` remain individually
addressable and `GetBlock` returns them happily.

## Implication: wipe-and-replay re-uses orphan containers

If you delete `chainData/<chainID>/db/` (subnet-evm's standalone
DB) but keep `db/<network>/` intact, restarting avalanchego
produces this sequence:

1. ProposerVM repair rolls its `lastAccepted` back to genesis.
2. Bootstrap asks peers for the **frontier** (current tip block
   IDs) — small network cost, not bulk.
3. Bootstrap walks back from tip; each ancestor lookup goes
   through `b.VM.GetBlock`, which **hits the local container
   store** for every block the previous sync had ingested.
4. `parseInnerBlock` extracts inner block bytes from each
   container and calls `ChainVM.ParseBlock` (subnet-evm). Parsing
   needs only the block bytes, not state.
5. Bootstrap then processes blocks in order: `Verify` → `Accept`
   on the inner VM. Each `Accept` writes to the freshly empty
   subnet-evm DB.

So the inner VM gets re-fed from the local container store, with
network usage limited to frontier discovery + filling any
genuinely missing containers (none, in our case). This is the
"cache will kick in" behaviour: ProposerVM's container store is
the cache.

## What still costs CPU

This is **not** a free re-sync. Every block still needs:
- `parseInnerBlock` (subnet-evm.ParseBlock) — RLP decoding etc.
- `Verify` — inner VM has to verify against parent state.
- `Accept` — write block + state changes to the inner DB.

For an EVM chain the dominant cost is execution
(`Verify`/`Accept`), not the byte transfer that we're skipping.
Wipe-and-replay savings are therefore **bandwidth** (no GetAncestors
RTTs) and **disk reads from peers' DBs** — not execution time.

## Source code references

- `~/avalanchego/snow/engine/snowman/bootstrap/bootstrapper.go:405-417` —
  local-first loop in `startSyncingBlocks`.
- `~/avalanchego/snow/engine/snowman/bootstrap/bootstrapper.go:437-462` —
  `fetch` (the network fallback path).
- `~/avalanchego/vms/proposervm/vm.go:368-370` — `VM.GetBlock`
  entry.
- `~/avalanchego/vms/proposervm/vm.go:767-771` — `getBlock` (post-
  fork attempt then pre-fork).
- `~/avalanchego/vms/proposervm/vm.go:774-789` — container-store
  lookup + inner-bytes extraction.
- See also `wiki/proposervm-startup-repair.md` for why the
  containers survive the lastAccepted-rollback during repair.
