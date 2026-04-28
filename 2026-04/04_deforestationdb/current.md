# Sync a subnet locally + probe per-chain DB delete-and-replay

**Goal**: Run a fresh local `avalanchego` in a new data dir,
partial-sync primary network only (skip C-chain and X-chain), track
subnet `j6HXQWdpRhX7yHMWLehUyYDjypHa455vP5tuiXZ81nkPgveFV` (blockchain
`2SfshBPqRJexmqdWBY2xYSTq2Rp2dDisuax7nQB6GyNqPjSWWY`, ~333k blocks).
Sync the subnet to tip, then delete *only* that chain's on-disk DB
(not the whole node DB), restart, and observe whether the node
re-executes the chain.
**Why this task**: Cheapest concrete probe of whether avalanchego can
be driven to re-execute a single chain's blocks selectively — the
core capability the executor/harness needs. Findings feed directly
into the harness-shape decision.
**Status**: not started

## Constraints

- **Do not touch the running `Avago-mainnet` container.** It stays
  up and running for the user's other projects. We don't read its
  data dir, don't copy its DB, don't stop it.
- Fresh, empty data dir. Sync from scratch — partial primary
  network sync should keep this cheap (just P-chain + target subnet,
  no C/X chain bloat).
- Local node ports must not collide with the running container.

## Plan

1. New branch in `~/avalanchego`.
2. Pick a fresh data dir (e.g., `~/deforestation-avago/`) and free
   ports for HTTP / staking / etc.
3. Start a local node from that branch — try `go run` first, build
   only if too slow / broken.
4. Flags:
   - `--partial-sync-primary-network=true` (P-chain only; skip C/X)
   - `--track-subnets=j6HXQWdpRhX7yHMWLehUyYDjypHa455vP5tuiXZ81nkPgveFV`
   - `--data-dir=<fresh dir>`
   - rebound `--http-port`, `--staking-port` so they don't collide
     with the running container.
5. Wait for sync. Subnet RPC lands at
   `http://localhost:<http-port>/ext/bc/2SfshB…WY/rpc`. Confirm tip
   via `eth_blockNumber` on that RPC.
6. **Record post-sync disk footprint — separately for the two DBs**:
   - **avalanchego DB** (P-chain, ProposerVM, peer state, etc.) —
     `~/deforestation-avago/db/mainnet/` (leveldb).
   - **subnet-evm DB** (the inner VM's own data — what we actually
     care about for this project) — under
     `~/deforestation-avago/chainData/<subnet-chain-id>/` (subnet-evm
     uses a standalone DB by default).
   Use `du -sh` on each, plus `df -h` snapshot. Write the numbers
   to a `wiki/` baseline entry (e.g.
   `wiki/subnet-2SfshB-baseline-size.md`) so we know the starting
   point this experiment was working from.
7. Stop the local node. Delete *only* the **subnet-evm DB** at
   `~/deforestation-avago/chainData/2SfshB…WY/db/` (verified
   layout: see `wiki/avalanchego-on-disk-layout.md`). Do NOT touch
   the avalanchego shared DB at `db/mainnet/` — for now this
   experiment only probes the subnet-evm side. The avalanchego
   state (P-chain, ProposerVM container index, etc.) stays intact.
8. Restart. **Updated expected behavior** (now backed by code,
   per `wiki/bootstrap-local-container-cache.md`): the
   bootstrapper's `startSyncingBlocks` checks `b.VM.GetBlock(blkID)`
   *before* falling back to network `fetch`. ProposerVM's
   `GetBlock` is a plain container-store lookup, not gated by the
   rolled-back `lastAccepted`. So:
   - ProposerVM repair rolls its pointer back to genesis (safe).
   - Bootstrap asks peers for the frontier (small network cost).
   - For every block 1..tip, the local container store hits;
     inner block bytes get extracted and re-fed to subnet-evm via
     `ParseBlock → Verify → Accept`.
   - Network usage stays small (frontier only, no GetAncestors
     for the bulk).
   So the user's "cache will kick in" gut feeling has a code-level
   basis. The experiment will validate this empirically.

   What we still expect to be costly: CPU (re-execution of every
   block on the inner VM). Savings are bandwidth + remote-disk
   I/O, not execution time.

   Sub-questions to verify on the live run:
   - Does the **subnet-evm-side** re-sync time look like
     CPU-bound (~similar to peers' execution rate) rather than
     network-bound? Compare to first-sync time.
   - Does `/proc/net/dev` show ~zero RX during re-sync (modulo
     frontier discovery + housekeeping gossip)?
   - Final subnet-evm DB size after re-sync — same as baseline?
   - Final avalanchego DB size — same as baseline (orphan
     containers reclaimed via the second sync re-pointing
     lastAccepted forward), or larger (orphans still
     unreferenced)?

## Open questions

- On restart with the subnet-evm DB gone, does the inner VM
  re-execute the chain locally from ProposerVM container bytes
  already in `db/mainnet/`, re-bootstrap from peers (network sync),
  or fail?
- Does `--partial-sync-primary-network` interact cleanly with
  tracking a subnet long-term? (P-chain validator state must stay
  fresh enough for subnet consensus — does partial sync still
  refresh it?)
- How long does the **subnet chain itself** take to bootstrap once
  P-chain is up? (333k blocks; 5-10 min was the estimate.)

## Resolved

- **Per-chain DB layout**: cleanly isolated. subnet-evm standalone
  DB lives at `chainData/<chainID>/db/`; avalanchego shared DB is
  separate at `db/<network>/`. See
  `wiki/avalanchego-on-disk-layout.md`.
- **`go run` viable**: yes, used in tmux session `deforest-avago`.
  First compile was a few minutes; node started cleanly and is
  bootstrapping P-chain.
- **P-chain bootstrap timing on this hardware**: fetch (~24.86M
  blocks) finished in ~1.5h; execute is ~4h, so end-to-end ~5-6h
  on a fresh node.

## Dead ends

- _(none yet)_

## Commands (ready to run when sync completes)

Subnet chain ID:
`SUBNET_CHAIN=2SfshBPqRJexmqdWBY2xYSTq2Rp2dDisuax7nQB6GyNqPjSWWY`

### Step 6 — record baseline disk sizes

```bash
DD=$HOME/deforestation-avago
SUBNET_CHAIN=2SfshBPqRJexmqdWBY2xYSTq2Rp2dDisuax7nQB6GyNqPjSWWY
echo "=== avalanchego shared DB (db/mainnet) ==="
du -sh $DD/db/mainnet
echo "=== subnet-evm standalone DB (chainData/<chain>/db) ==="
du -sh $DD/chainData/$SUBNET_CHAIN/db
echo "=== full chainData/<chain> tree (for reference) ==="
du -sh $DD/chainData/$SUBNET_CHAIN
echo "=== top-level data-dir ==="
du -sh $DD
echo "=== disk free ==="
df -h $DD
echo "=== subnet RPC head ==="
curl -s -X POST -H "content-type:application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}' \
  http://127.0.0.1:9660/ext/bc/$SUBNET_CHAIN/rpc
```

Then write the numbers to
`wiki/subnet-2SfshB-baseline-size.md` (use template
`templates/fact.md`).

### Step 7 — surgical wipe of the subnet-evm DB

Stop the node first (in the tmux pane: `Ctrl-c`, wait for graceful
shutdown). Then:

```bash
DD=$HOME/deforestation-avago
SUBNET_CHAIN=2SfshBPqRJexmqdWBY2xYSTq2Rp2dDisuax7nQB6GyNqPjSWWY
# Sanity: confirm path exists and we're not nuking the wrong thing
ls -la $DD/chainData/$SUBNET_CHAIN/db
# Move (not delete) so we can restore quickly if something goes wrong
mv $DD/chainData/$SUBNET_CHAIN/db $DD/chainData/$SUBNET_CHAIN/db.preexp-$(date +%s)
```

`mv` instead of `rm -rf` keeps a recoverable copy until we're sure
the experiment outcome is correct; we can `rm -rf` the
`db.preexp-*` dir at the end if everything is fine.

Confirm `db/mainnet/` is untouched:

```bash
du -sh $DD/db/mainnet  # should match the baseline
```

### Step 8 — restart and measure re-sync

```bash
# Restart avalanchego in the same tmux session (re-press the up
# arrow + Enter). Then poll subnet-bootstrap status:
SUBNET_CHAIN=2SfshBPqRJexmqdWBY2xYSTq2Rp2dDisuax7nQB6GyNqPjSWWY
URL=http://127.0.0.1:9660/ext/info
START=$(date +%s)
while true; do
  R=$(curl -s -X POST -H "content-type:application/json" \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"info.isBootstrapped\",\"params\":{\"chain\":\"$SUBNET_CHAIN\"}}" $URL)
  echo "$(date +%H:%M:%S) $R"
  echo "$R" | grep -q '"isBootstrapped":true' && break
  sleep 30
done
END=$(date +%s)
echo "Subnet re-sync took $((END-START))s"
```

Capture for the writeup:
- elapsed re-sync seconds
- network bytes received during the re-sync (sample
  `/proc/net/dev` before/after)
- final subnet-evm DB size — same? larger (compaction not yet
  done)?
- final avalanchego DB size — same? larger (orphan containers
  still there)?

## Notes

This task supersedes the previous "decide harness shape" framing on
this scratchpad: the probe here gives concrete evidence about what
avalanchego will and won't let us do, which the harness decision
needs.
