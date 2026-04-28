---
name: avalanchego-on-disk-layout
description: Where avalanchego puts the shared node DB and per-chain data; how subnet-evm's standalone DB nests inside it.
type: reference
last_verified: 2026-04-28
---

# avalanchego on-disk layout (data-dir → DB → chainData)

When started with `--data-dir=<DD>`, avalanchego creates the
following on-disk layout. Citations are against the working trees
at `~/avalanchego` and `~/subnet-evm` as of 2026-04-28.

## Top-level

```
<data-dir>/
  db/<network-name>/        # shared node DB (leveldb by default)
  chainData/<chainID>/      # per-chain data dir, one subdir per chain
  logs/                     # avalanchego logs
  staking/                  # node TLS + BLS keys
  plugins/
  process.json
  profiles/
```

The shared node DB path is decided in `config/config.go` (built from
`databaseConfig.path = <data-dir>/db/<network-name>`). For mainnet
the network name is literally `mainnet`, so e.g.
`/home/ubuntu/deforestation-avago/db/mainnet/`.

## Per-chain ChainDataDir

Each chain (P-chain, C-chain, X-chain, every subnet chain) gets its
own subdirectory under the data dir's `chainData/`:

```
<data-dir>/chainData/<chainID>/
```

Built in `chains/manager.go:486`:

```go
chainDataDir := filepath.Join(m.ChainDataDir, chainParams.ID.String())
if err := os.MkdirAll(chainDataDir, perms.ReadWriteExecute); err != nil {
    return nil, fmt.Errorf("error while creating chain data directory %w", err)
}
```

This dir is then passed to the chain VM as `ctx.ChainDataDir`
(`chains/manager.go:518`). What the VM stores in there is
VM-specific.

## What lives in the *shared* node DB vs the chain's ChainDataDir

- **Shared node DB** (`db/<network>/`) holds:
  - P-chain consensus state.
  - ProposerVM container index for every tracked chain (the
    proposervm wrapper's own DB). ProposerVM is namespaced inside
    the same shared env, *not* inside `chainData/<chainID>`.
  - Validator/peer/network state.
- **`chainData/<chainID>/`** holds whatever the inner VM chooses to
  put there. For coreth and subnet-evm with a standalone DB, this
  is the entire EVM chain database.

## subnet-evm: standalone DB at `chainData/<chainID>/db`

If subnet-evm uses a standalone database (default for fresh chains
— see `wiki/subnet-evm-database-layout.md`), it places the EVM
database at `<ChainDataDir>/db/`. From
`subnet-evm/plugin/evm/vm_database.go:160`:

```go
dbPath := filepath.Join(chainDataDir, "db")
if len(config.DatabasePath) != 0 {
    dbPath = config.DatabasePath
}
```

So for our experiment with subnet `2SfshB…WY` and
`--data-dir=/home/ubuntu/deforestation-avago`, the on-disk layout
ends up as:

```
/home/ubuntu/deforestation-avago/
  db/mainnet/                                                    # avalanchego shared DB (leveldb): P-chain + ProposerVM container index
  chainData/2SfshBPqRJexmqdWBY2xYSTq2Rp2dDisuax7nQB6GyNqPjSWWY/
    db/                                                          # subnet-evm standalone DB (default pebble)
    [other VM-side artifacts the EVM may write here]
```

## Implication for delete-and-replay experiments

To wipe **only the inner VM's view of the chain** while preserving
the avalanchego shared state (ProposerVM containers etc.), delete
just `chainData/<chainID>/db/` (or the whole `chainData/<chainID>/`
subtree if you want the inner VM fully fresh).

Do NOT touch `db/<network>/` if you want to keep the ProposerVM
container store and P-chain state — those are critical for the
node to continue running, and the ProposerVM container index is
exactly the artifact we'd want to test as a re-execution source.

## Source code references

- `~/avalanchego/chains/manager.go:486-518` — chainDataDir
  construction and injection into chain ctx.
- `~/avalanchego/config/config.go` (search `databaseConfig`,
  `path`) — shared DB path = `<data-dir>/db/<network-name>`.
- `~/subnet-evm/plugin/evm/vm_database.go:53-77` — standalone DB
  entry point.
- `~/subnet-evm/plugin/evm/vm_database.go:140-171` — standalone DB
  path = `<chainDataDir>/db` unless overridden.
