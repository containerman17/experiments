---
name: proposervm-startup-repair
description: ProposerVM rolls its own lastAccepted pointer back to inner VM's height on every startup; treats inner-ahead-of-pro as fatal.
type: reference
last_verified: 2026-04-28
---

# ProposerVM startup repair (`repairAcceptedChainByHeight`)

ProposerVM runs `repairAcceptedChainByHeight` during `Initialize`
(`vm.go:187`, also called from `SetState` at `vm.go:334`). The
function compares ProposerVM's lastAccepted height against the
inner VM's lastAccepted height and reconciles, **biased toward
trusting the inner VM**.

## The three cases

From `~/avalanchego/vms/proposervm/vm.go:610-681`:

```go
proLastAcceptedHeight := proLastAccepted.Height()
innerLastAcceptedHeight := innerLastAccepted.Height()

// Case 1: pro < inner — fatal error
if proLastAcceptedHeight < innerLastAcceptedHeight {
    return fmt.Errorf("proposervm height index (%d) should never be
        lower than the inner height index (%d)",
        proLastAcceptedHeight, innerLastAcceptedHeight)
}

// Case 2: pro == inner — no-op
if proLastAcceptedHeight == innerLastAcceptedHeight {
    return nil
}

// Case 3: pro > inner — roll ProposerVM back to inner's height
// (a) if rolling past fork: delete pro's lastAccepted entirely
//     (vm.go:655-662)
// (b) else: set pro's lastAccepted to the post-fork block at
//     innerLastAcceptedHeight via GetBlockIDAtHeight
//     (vm.go:664-678)
```

## What this means structurally

- **Inner VM is the source of truth for height.** ProposerVM
  follows. A persistence asymmetry where pro is *ahead* on disk is
  expected and tolerated; pro *behind* on disk is unrecoverable
  ("should never" in the error message).
- This is the same Pebble-ahead-OK / Firewood-ahead-fatal pattern
  we adopted for our own design (see decisions.md "Per-block Pebble
  fsync as the Firewood durability primitive"). avalanchego
  upstream uses the same shape between ProposerVM (outer) and the
  inner ChainVM.

## What the repair touches in the shared DB

The repair **only modifies the `lastAccepted` key** in
ProposerVM's State (and one DB.Commit). Specifically:

- `State.SetLastAccepted(newID)` (`vm.go:672-674`) — overwrites
  the pointer to the post-fork block at the new height.
- Or `State.DeleteLastAccepted()` (`vm.go:658-661`) — only when
  rolling past the fork height entirely.

It does **not** iterate through and delete per-container index
entries. The actual container blob storage is untouched; only the
"head" pointer moves. After repair, container entries for blocks
> innerLastAcceptedHeight are physically present in the DB but
unreferenced by the ProposerVM head.

## Implication: deleting the inner VM's standalone DB

For our experiment (delete `chainData/<chainID>/db/`, keep
`db/<network>/`):

1. Inner VM restarts with empty DB → `LastAccepted()` returns
   genesis (height 0).
2. `repairAcceptedChainByHeight` sees `pro=tip, inner=0` → Case 3.
3. ProposerVM's lastAccepted gets rolled back to the genesis
   post-fork block (or deleted, if genesis is below fork height).
4. The node's *logical* head is now at genesis on both sides.
5. **The container store entries from blocks 1..tip are still
   physically present** in `db/<network>/` but unreferenced.
6. Subsequent ChainVM bootstrap will fetch blocks from peers per
   the standard protocol — it does not opportunistically replay
   from the orphaned containers.

So **the experiment is safe** (no fatal error), but it is **not** a
test of "re-execute from local ProposerVM containers" — it's a
test of "the node correctly returns to genesis and re-syncs from
peers." A separate experiment would be needed to probe whether the
orphaned containers can be reused as a re-execution source (would
likely require a custom bootstrapper or a tool that crawls the
container store directly).

## Source code references

- `~/avalanchego/vms/proposervm/vm.go:187` — repair invoked from
  `Initialize`.
- `~/avalanchego/vms/proposervm/vm.go:334` — repair invoked from
  `SetState`.
- `~/avalanchego/vms/proposervm/vm.go:610-681` — repair body.
- `~/avalanchego/vms/proposervm/vm.go:635-636` — fatal error on
  `pro < inner`.
- `~/avalanchego/vms/proposervm/vm.go:655-662` — past-fork
  branch (delete lastAccepted entirely).
- `~/avalanchego/vms/proposervm/vm.go:664-678` — normal-branch
  rollback via height index.
