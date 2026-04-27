# Subnet-EVM database layout & single-DB option

**System**: subnet-evm, coreth, avalanchego (ProposerVM)
**Last verified**: 2026-04-27

## Summary

Subnet-EVM and coreth (C-Chain) both implement the avalanchego
`block.ChainVM` interface and accept an `avalanchedatabase.Database` in
`Initialize()`. Both wrap it via `avalanchego/vms/evm/database.New()` to
adapt to libevm's `ethdb.KeyValueStore`. The database adaptation code
is shared, not forked.

The key behavioral difference: **subnet-evm has a `UseStandaloneDatabase`
config flag**; coreth always uses the avalanchego-provided DB. For new
subnet-evm chains (no `lastAcceptedKey` yet), the default is
**standalone = true** — subnet-evm opens its own DB at
`chainDataDir/db/...`, separate from avalanchego's.

For existing chains, subnet-evm keeps using avalanchego's DB.

ProposerVM **always** lives in avalanchego's chain DB regardless of the
inner VM's choice, under prefix `proposervm`. It also passes the same
avalanchego DB to the inner VM.

For the archive: forcing `UseStandaloneDatabase=false` on subnet-evm
chains unifies everything into one Pebble env per chain. C-Chain
already does this by default.

## Evidence

### Interface & shared adaptation

- `/home/ubuntu/subnet-evm/plugin/evm/vm.go:275` —
  `Initialize(ctx, chainCtx, db database.Database, ...)`. Same signature
  in `/home/ubuntu/coreth/plugin/evm/vm.go:261`.
- `/home/ubuntu/avalanchego/database/database.go:89-96` — definition of
  `database.Database` interface (Get, Put, Delete, Has, Batch, Iterate,
  Compact, Close).
- `/home/ubuntu/avalanchego/vms/evm/database/database.go` — single
  adapter from avalanchego's `Database` to libevm's `ethdb.KeyValueStore`.
  Both subnet-evm and coreth import this.

### Subnet-EVM standalone-DB logic

- `/home/ubuntu/subnet-evm/plugin/evm/vm_database.go:55-97` —
  `initializeDBs`. Branches on `vm.useStandaloneDatabase()`. If
  standalone: opens a new DB via
  `newStandaloneDatabase(dbConfig, vm.ctx.Metrics, vm.ctx.Log)` at
  `chainDataDir/db/<dbtype>`. If not: uses the avalanchego-provided DB.
- `/home/ubuntu/subnet-evm/plugin/evm/vm_database.go:121-137` —
  `useStandaloneDatabase`: if config flag is set, honors it; otherwise
  checks `acceptedDB.Get(lastAcceptedKey)` — if `ErrNotFound` (new chain),
  defaults to **standalone = true**; else stays with avalanchego's DB.
- `/home/ubuntu/subnet-evm/plugin/evm/config/config.go:187` —
  `UseStandaloneDatabase *PBool \`json:"use-standalone-database"\`` —
  the chain config flag.

### Subnet-EVM key prefixes (whichever DB is chosen)

`/home/ubuntu/subnet-evm/plugin/evm/vm_database.go:82-95`:
- `chaindb`: `prefixdb.NewNested(ethDBPrefix, db)` (state, blocks)
- `versiondb`: wraps `db`
- `acceptedBlockDB`: `prefixdb.New(acceptedPrefix, vm.versiondb)`
- `metadataDB`: `prefixdb.New(metadataPrefix, vm.versiondb)`
- `warpDB`: `prefixdb.New(warpPrefix, db)` (NOT in versiondb)
- `validatorsDB`: `prefixdb.New(validatorsDBPrefix, db)` (NOT in versiondb)

### Coreth always single-DB

- `/home/ubuntu/coreth/plugin/evm/vm_database.go:19-32` — `initializeDBs`
  has no standalone branch. Comment at line 19: `// coreth always uses
  the avalanchego provided database.` Same prefix structure as
  subnet-evm but no warpDB optionality and no `usingStandaloneDB` flag.

### ProposerVM always in avalanchego's DB

- `/home/ubuntu/avalanchego/vms/proposervm/vm.go:64` — `dbPrefix =
  []byte("proposervm")`.
- `/home/ubuntu/avalanchego/vms/proposervm/vm.go:153` — `vm.db =
  versiondb.New(prefixdb.New(dbPrefix, db))` — the `db` here is the
  avalanchego-provided chain DB.
- ProposerVM also passes the same `db` to the inner VM's `Initialize()`,
  so the inner VM can choose to honor it or not — ProposerVM doesn't
  know about the inner VM's standalone choice.

## Implications

For the archive:
- Set `"use-standalone-database": false` in the chain config for every
  subnet-evm chain we run. This routes ALL inner-VM writes (chaindb,
  versiondb, acceptedBlockDB, metadataDB, warpDB, validatorsDB) through
  the avalanchego-provided DB.
- ProposerVM data (block index, height map) lives in the same DB under
  prefix `proposervm/`. Net: one Pebble env per chain, all data with
  predictable prefixes.
- C-Chain (coreth) needs no action — already single-DB by default.
- This is the prerequisite for owning the commit ordering with Firewood
  (single coordinated batch per block).
- Backed `decisions.md` 2026-04-27 entry "Force single-DB for subnet-evm
  chains."

## Caveats

- The default for new chains is standalone=true. We must explicitly
  set the flag false on chain genesis or first run.
- For subnet-evm chains that have already accepted blocks against an
  avalanchego DB (i.e., never were standalone), they stay shared — no
  action needed but worth confirming per chain.
