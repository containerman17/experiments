---
name: subnet-2SfshB-baseline-size
description: On-disk footprint after a fresh sync of subnet 2SfshB…WY (chain ID), partial-primary-network, no C/X. Used as the experiment baseline for delete-and-replay.
type: reference
last_verified: 2026-04-28
---

# Baseline disk sizes for subnet 2SfshB…WY (post-fresh-sync)

## Identity

- **Subnet ID**: `j6HXQWdpRhX7yHMWLehUyYDjypHa455vP5tuiXZ81nkPgveFV`
- **Blockchain ID**: `2SfshBPqRJexmqdWBY2xYSTq2Rp2dDisuax7nQB6GyNqPjSWWY`
- **VM ID**: `WFhM9GmcSXUULSJj9kpUoph23gLMsEvrBhwwS4kz29zFBcLSf`
  (custom-registered subnet-evm vmID for this chain — not the
  default `srEXi…6X7Dy`).
- **Chain at sync completion**: tip = `0x5012e` (327,950) per
  `eth_blockNumber`.
- **Sync mode**: `--partial-sync-primary-network=true`,
  `--track-subnets=j6HXQ…veFV`. C-chain and X-chain skipped.
- **avalanchego version**: built from local commit `29b4e6bc54`
  (matches subnet-evm slimarchive's go.mod pin
  `v1.14.1-0.20251111165133-29b4e6bc541b`).
- **subnet-evm version**: built from `~/subnet-evm` branch
  `slimarchive`, commit `6aa7af7e6` (wip on top of slim-archive
  feature commits).

## Sizes (measured 2026-04-28 ~03:10 UTC)

| Subsystem | Path | Size |
|---|---|---|
| avalanchego shared DB | `~/deforestation-avago/db/mainnet/` | **45 GB** |
| subnet-evm standalone DB | `~/deforestation-avago/chainData/<chainID>/db/` | **1.9 GB** |
| Full `chainData/` | `~/deforestation-avago/chainData/` | 1.9 GB |
| Full data dir | `~/deforestation-avago/` | **47 GB** |

Host disk free at this point: 164 GB on a 2.4 TB volume (94% used).

## Composition notes

- The 45 GB on the avalanchego side is dominated by P-chain state
  (24.86M blocks, executed during the 3h17m bootstrap) plus
  ProposerVM container store entries for the ~328k tracked-subnet
  blocks. We did not break this down at this snapshot.
- The 1.9 GB subnet-evm DB is the entire post-state of a 328k-block
  EVM chain (state trie + receipts + tx index for whatever the VM
  configuration retains).
- Ratio is ~24:1 in favour of avalanchego — almost entirely a
  consequence of the P-chain bootstrap requirement (we synced 24M+
  P-chain blocks to track a 0.3M-block subnet). For a node tracking
  *many* subnets this ratio falls dramatically; for a single small
  subnet, P-chain dominates.

## Sync timings (also part of the baseline)

| Phase | Wall time |
|---|---|
| P-chain fetch (24.86M blocks) | ~1h30m |
| P-chain execute | 3h16m51s |
| **P-chain total (cold)** | **~4h47m** |
| Subnet-evm fetch (327,966 blocks) | ~3m20s |
| Subnet-evm execute | ~3m45s |
| **Subnet-evm total (network bootstrap)** | **~7m05s** |

## Why this baseline matters

Step 7-8 of the experiment in `current.md` deletes only the
subnet-evm DB (1.9 GB) and restarts. Expected outcome from
`wiki/bootstrap-local-container-cache.md`: re-sync hits the local
ProposerVM container store (already in `db/mainnet/`) instead of
the network. Empirical questions:

- How fast is the second subnet-bootstrap vs the first 7m05s?
  (CPU-bound replay of 328k EVM blocks should still take a few
  minutes; bandwidth-bound fetch should drop to near-zero.)
- Does the subnet-evm DB end at the same 1.9 GB?
- Does the avalanchego DB grow (orphans in addition to refilled
  ProposerVM head), stay flat, or shrink (compaction)?
