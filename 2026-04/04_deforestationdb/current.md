# Decide harness shape — avalanchego-hosted or separate executor

**Goal**: Pick the harness model that lets us iterate without
re-downloading + re-executing blocks every dev cycle.
**Why this task**: This decision shapes whether all subsequent tasks are
small patches inside avalanchego (fit-in model) or live in our own
binary tree (separate-executor model). Wrong choice = months wasted.
**Status**: stuck (haven't started yet)

## Approach being tried

Investigate whether subnet-evm + ProposerVM can be hosted in-process
under our own binary, without forking avalanchego. The current
prototype at `~/deforestationdb/executor/` already does something
adjacent: it executes blocks against libevm + Firewood without a full
avalanchego runtime. The question is whether we can extend that to
present an `ethapi.Backend` for RPC and a `ChainVM` for P2P serving,
both backed by our own storage.

## Open questions

- How does subnet-evm react when started with an empty DB? (It auto-defaults
  to standalone DB for new chains — but does it then try to bootstrap from
  network? Can we feed it pre-fetched blocks?)
- Can avalanchego's `Initialize(ctx, chainCtx, db, ...)` be driven externally
  — i.e., we instantiate the VM ourselves and feed it our DB? Or is the
  flow tightly coupled to the avalanchego node binary?
- What's the smallest "do-nothing" engine we can pass to satisfy the
  ChainVM consensus side, so we can drive block acceptance synchronously
  from our own loop?
- Does in-process hosting break any package-private assumptions in
  subnet-evm or ProposerVM?

## Dead ends

- _(none yet)_

## Notes

If fit-in wins: each future task = one focused patch to avalanchego or
subnet-evm. Pro: less code to own. Con: each PR = ~1 month.

If separate-executor wins: we own the harness; tasks are local. Pro:
fast iteration, no upstream coupling. Con: harness itself is ~weeks of
work, and we eventually need to be feedable back upstream somehow.

The `~/deforestationdb/` prototype's existence is evidence that
separate-executor is feasible at small scale. Question is whether it
scales to the full RPC surface.
