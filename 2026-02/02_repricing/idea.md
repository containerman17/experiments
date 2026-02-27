# C-Chain Opcode Repricing Impact Study (Helicon Context)

## Scope
This document is a full rewrite from scratch based on:
- the provided internal chat content (without names), and
- direct local-node exploration on `http://127.0.0.1:9650/ext/bc/C/rpc`.
- downloaded `XENCrypto` source/ABI (`0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389`) from local routescan dump.

All transaction hashes and addresses are full-length.

## Core Question
We need an exact answer, not a heuristic estimate:

"Which exact canonical transactions would have reverted if repricing had been active a few days earlier?"

## Discussion Distillation
The internal discussion converges on these points:
- Increasing target/capacity alone does not solve spam economics.
- Raising minimum gas price (static or dynamic) can suppress spam, but also suppresses legitimate low-price activity.
- A bot-based gas burner has operational and optics cost and is not a clean long-term solution.
- Long-term direction is opcode repricing so the targeted pattern becomes relatively more expensive than normal usage.
- Repricing can break contracts, especially fixed-gas internal call patterns.
- Repricing cold `SLOAD` is high-risk for DeFi compatibility and should be avoided in the first iteration.
- Candidate focus is `SSTORE` (especially zero->nonzero path) and `CREATE`/`CREATE2`.
- A real impact study is required before shipping repricing.

## What We Measured on the Local Node

### Node behavior and replay window
- Client version: `v0.15.4`
- `debug_trace*` works for recent history.
- Historical state is not full-archive; traceability window is finite.
- In-session measurement found approximately:
  - latest block: `79119636`
  - earliest traceable block: `78194776`
  - traceable window: `924861` blocks

Implication: "last few days" is feasible on this node; deep historical backfills are not.

### Important trace caveat
`CALL` and `DELEGATECALL` gas in `structLogs` is inclusive and causes double counting if summed naively. Use those fields for direction, not exact additive attribution.

### Current XEN counters (same node snapshot)
- Contract: `0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389`
- at block `79119636`:
  - `activeMinters = 49,755,841`
  - `globalRank = 79,223,529`
  - `activeStakes = 5,438`

Interpretation: the active mint set is currently very large, consistent with state-expansion concern being real and ongoing.

### Recent flow check (last 10,000 blocks)
- block range: `0x4b71e11` -> `0x4b74521`
- `RankClaimed` events: `52,619`
- `MintClaimed` events: `49,569`
- net mint growth (rank claims - mint claims): `+3,050`

Interpretation: in this recent window, growth outpaced cleanup.

## Empirical Transaction Findings

### Sample A
- tx hash: `0x0e39d094442e515dee8c15b5c19c702d4d128cc3d61b3766f3dfc020409a89e9`
- block: `79115450` (`0x4b734ba`)
- gas used: `3707674` (`0x38931a`)
- to: `0x9ec1c3dcf667f2035fb4cd2eb42a1566fd54d2b7`
- logs: `200`
- input bytes: `2052`
- opcode counts/gas highlights:
  - `SSTORE`: `950` ops, `943400` gas
  - `CREATE`: `0`
  - `CREATE2`: `0`
- prestate diff mode summary:
  - storage changed: `203`
  - new slots (zero/absent -> nonzero): `0`
  - overridden slots (nonzero -> nonzero): `203`
  - cleared slots (nonzero -> zero): `0`

### Sample B
- tx hash: `0x8419469c99288b24b9f49abe20b96c2f7173a78f10bc5fbc92fdbaac46b23cfe`
- block: `79080939` (`0x4b6adeb`)
- gas used: `3707662` (`0x38930e`)
- to: `0x9ec1c3dcf667f2035fb4cd2eb42a1566fd54d2b7`
- logs: `200`
- input bytes: `2052`
- opcode counts/gas highlights:
  - `SSTORE`: `950` ops, `943400` gas
  - `CREATE`: `0`
  - `CREATE2`: `0`
- prestate diff mode summary:
  - storage changed: `203`
  - new slots (zero/absent -> nonzero): `0`
  - overridden slots (nonzero -> nonzero): `203`
  - cleared slots (nonzero -> zero): `0`

### Sample C (very high gas)
- tx hash: `0x6f516be092eb201927cc88badf664852f4aa76737e9a7825b006259909c14867`
- block: `79078562` (`0x4b6a4a2`)
- gas used: `17140495` (`0x1058b0f`)
- to: `0x0000000000771a79d0fc7f3b7fe270eb4498f20b`
- logs: `101`
- input bytes: `68`
- opcode counts/gas highlights:
  - `SSTORE`: `810` ops, `11034800` gas
  - `CREATE`: `0`
  - `CREATE2`: `100` ops, `3201600` gas
- prestate diff mode summary:
  - storage changed: `512`
  - new slots (zero/absent -> nonzero): `507`
  - overridden slots (nonzero -> nonzero): `5`
  - cleared slots (nonzero -> zero): `0`

## Contract-Source Findings (XEN Core vs Wrappers)

### Verified `XENCrypto` behavior
- Contract analyzed: `0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389` (`XENCrypto`, Solidity `v0.8.17`).
- Source body extracted from standard-json at:
  - `/tmp/routescan/0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389/sources/XENCrypto.extracted.sol`
- `XENCrypto` has no contract-creation opcodes in source path (no `CREATE`/`CREATE2` in contract logic).
- Core write-heavy functions:
  - `claimRank(uint256)` selector `0x9ff054df`
  - `claimMintRewardAndShare(address,uint256)` selector `0x1c560305`
  - `claimMintReward()` selector `0x52c7f8dc`
  - `claimMintRewardAndStake(uint256,uint256)` selector `0x5bccb4c4`
- Cleanup path `_cleanUpUserMint()` deletes `userMints[msg.sender]` and decrements `activeMinters` (overwrite/churn behavior).

### XEN state footprint
- The `XENCrypto` contract alone holds **227M storage slots** — 34% of all slots on C-Chain and 25% of total slot size.
- `userMints` mapping: `MintInfo` struct uses **6 storage slots** per entry (address `user` 20 bytes in own slot, then 5 × uint256: `term`, `maturityTs`, `rank`, `amplifier`, `eaaRate`).
- `_balances` mapping (inherited ERC20): 1 slot per unique address that ever received XEN.
- Do not infer exact unique proxy/account count from `227M / 7`: real slot occupancy varies with runtime values (for example, zero-valued fields like `eaaRate`) and scanner accounting details.
- Cross-check from chain counters shows very large live state regardless: `activeMinters` is ~`49.8M` at block `79119636`.

### Logical write counts per XEN function (from source)
- `claimRank(term)`: **8 logical storage writes** per call
  - 6 writes for `userMints[msg.sender] = mintInfo` (struct fields)
  - 1 write for `activeMinters++`
  - 1 write for `globalRank++`
  - emits 1 event (`RankClaimed`)
- `claimMintReward()`: **9 logical storage writes** per call
  - 2 writes for `_mint()` (`_totalSupply`, `_balances[msg.sender]`)
  - 6 writes for `delete userMints[msg.sender]` (zeros all struct fields)
  - 1 write for `activeMinters--`
  - emits 2 events (`Transfer`, `MintClaimed`)
- `claimMintRewardAndShare(address,uint256)`: **up to 10 logical storage writes** per call
  - 3 writes for `_mint()` × 2 (`_totalSupply`, `_balances[msg.sender]`, `_balances[other]`)
  - 6 writes for `delete userMints[msg.sender]`
  - 1 write for `activeMinters--`
  - emits 3 events (`Transfer` × 2, `MintClaimed`)
- Runtime gas is not fixed by these counts alone; EIP-2200/3529 charging depends on slot state (`original`, `current`, `new`) and warm/cold access.

### EIP-2200/3529 dirty-slot discount (critical for recycling economics)
The recycling pattern (Samples A/B) combines `claimMintRewardAndShare` + `claimRank` per proxy in a single tx.
For each MintInfo slot this creates the sequence:
1. `delete userMints[proxy]` → original=nonzero, current=nonzero, new=0
   - Clean slot: SSTORE_RESET cost 4,900 gas, refund 4,800 → net ~100 gas
2. `claimRank` rewrites same slot → original=nonzero, current=0, new=nonzero
   - **Dirty slot** (original ≠ current): cost **100 gas** (warm read only)

Total per slot per cycle: **~200 gas** instead of **20,000 gas** (SSTORE_SET for fresh slot).
This is a **100× discount** that the recycling pattern exploits. It explains why Samples A/B use only 3.7M gas
for 950 SSTOREs (~993 gas/SSTORE average) while Sample C uses 17.1M gas for 810 SSTOREs (~13,600 gas/SSTORE average).

**Key implication (for sampled recycling txs)**: repricing SSTORE_SET (the 20,000 gas path for `original == 0 → nonzero`) will have little effect
on that recycling loop because it mostly hits dirty-slot paths instead.
Repricing SSTORE_SET only targets true state expansion (new slots that didn't exist before the tx started).

### Identified wrapper contracts
- `0x9ec1c3dcf667f2035fb4cd2eb42a1566fd54d2b7` = **CoinTool: XEN Batch Minter** (cointool.app/batchMint/xen)
  - Deploys proxy contracts once, then cycles them indefinitely (claim rewards → re-register).
  - Deployed across multiple EVM chains at the same address.
- `0x0000000000771a79d0fc7f3b7fe270eb4498f20b` = **MCT: XEN batch mint NFT (MXENFT)** (mct.xyz)
  - Deploys fresh EIP-1167 minimal proxy contracts via CREATE2 per batch, tied to NFT token IDs.
  - Calls `selfdestruct` (`powerDown()`) on proxies after claiming rewards.

### Trace-resolved call paths for sampled txs
- Sample A/B (`to: 0x9ec1...` CoinTool, input selector `0xc2580804`):
  - `CREATE2`: `0`
  - calls into `XENCrypto`: `100` total
  - breakdown: `50 x claimRank(0x9ff054df)` + `50 x claimMintRewardAndShare(0x1c560305)`
  - Confirms recycling: each proxy does claim + re-register in one tx, exploiting dirty-slot discount.
- Sample C (`to: 0x000...771a...` MCT, selector `0x8973e2cb`):
  - `CREATE2`: `100`
  - calls into `XENCrypto`: `101` total
  - breakdown: `100 x claimRank(0x9ff054df)` + `1 x userMints(address)` read (`0xdf282331`)
  - Pure expansion: 100 new proxy accounts + 507 new storage slots.

Implication: create-heavy behavior is wrapper/orchestrator-level, while repeated storage writes happen inside `XENCrypto` calls.

## Gas Limit Headroom in Samples
- Sample A:
  - gas limit: `0x393870` = `3,750,000`
  - gas used: `3,707,674`
  - headroom: `42,326`
- Sample B:
  - gas limit: `0x393870` = `3,750,000`
  - gas used: `3,707,662`
  - headroom: `42,338`
- Sample C:
  - gas limit: `0x10b0760` = `17,500,000`
  - gas used: `17,140,495`
  - headroom: `359,505`

Interpretation: overwrite-heavy batches already run close to gas limit; relatively modest repricing of dominant ops can flip execution to out-of-gas/revert.

## Interpretation
The sample set shows at least two distinct high-gas archetypes:

1. Recycling pattern (Samples A/B) — CoinTool
- No observed `CREATE`/`CREATE2`. Proxy contracts already deployed.
- 50 proxies per tx, each doing `claimMintRewardAndShare` + `claimRank` in sequence.
- No net new storage slots in poststate diff (delete + rewrite = nonzero→nonzero in diff).
- Exploits EIP-2200/3529 dirty-slot discount: ~200 gas per slot instead of 20,000.
- **Does not grow state.** Consumes block space only.

2. Expansion pattern (Sample C) — MCT
- 100 CREATE2 ops deploying fresh EIP-1167 proxy contracts.
- Each proxy calls `claimRank`, writing 6 new MintInfo slots (zero→nonzero, full 20,000 gas each).
- 507 new slots + 100 new accounts = **permanent state trie growth**.
- `SSTORE_SET` and `CREATE2` dominate: ~13.3M of 17.1M gas (78%).

### Immediate policy implication
- Repricing `SSTORE_SET` (zero→nonzero) + `CREATE2` targets state expansion (Pattern 2) directly.
- This is the **lower-collateral path**: sampled recycling txs (Pattern 1) are far less sensitive because they mostly avoid SSTORE_SET.
- For normal DeFi, overwrite-heavy paths are least affected; flows that create new storage (new pools/markets/positions) can still see impact.
- Recycling is primarily block-space pressure; long-term slot growth is dominated by expansion-phase operations.
- If block-space consumption by recyclers is also a concern, that requires either broader SSTORE repricing
  (high DeFi compatibility risk) or base-fee / gas-limit mechanisms (already partially addressed by gas burner).
- Doubling SSTORE_SET (20k→40k) and CREATE2 (32k→64k) would push Sample C from 17.1M to ~30M gas,
  likely exceeding block gas limit — forcing smaller batches, more txs, and natural base-fee pressure.

## Required Method for Exact Answer
To answer the core question precisely, use full counterfactual replay (not tracer-only heuristics):

1. Patch opcode pricing in EVM execution (Go, core engine path).
2. Replay canonical blocks in original transaction order.
3. Compare repriced execution vs canonical receipts/results.
4. Record at minimum:
   - `block_number`
   - `tx_index`
   - `tx_hash`
   - `original_status`
   - `repriced_status`
   - `original_gas_used`
   - `repriced_gas_used`
   - `status_changed`
5. Add a second bucket for "status unchanged but behavior changed" (log/output/state-diff mismatch).

## Caching Strategy (Practical)
Given node constraints and workload size, cache aggressively:
- Block/receipt cache
- Trace cache (optional for analysis/debug workflows)
- Local execution state snapshot cache (load on startup, merge new state, persist)

This enables stable re-runs and parameter sweeps without repeating all RPC work.

## Decision Guidance for Helicon
- If the goal is **state-growth suppression**: reprice `SSTORE_SET` (zero→nonzero) + `CREATE2`. This is the lower-collateral,
  targeted path. It is expected to have limited effect on sampled recycling txs and lower collateral impact than broad SSTORE repricing.
  Normal DeFi impact should be smaller than broad repricing, but not zero for protocols creating new slots.
  The 227M-slot XEN footprint (34% of all C-Chain state) is consistent with expansion-heavy operations that this repricing targets.
- If the goal is **also suppressing block-space consumption** by recyclers: this requires either broader
  `SSTORE_RESET` repricing (high DeFi compatibility risk — every Uniswap swap, every lending position update
  uses SSTORE_RESET) or continued reliance on base-fee mechanisms.
- Do not reprice cold `SLOAD` in the first iteration (high DeFi breakage risk, as noted in prior discussion).
- The replay study (counterfactual execution with patched gas costs) remains required before activation to
  identify any legitimate contracts that would break under the new pricing.
