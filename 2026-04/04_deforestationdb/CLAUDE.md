# 04_deforestationdb — notes & knowledge system

## What this is

This directory is the workspace for an exploratory archive-node design
project (compact, verifiable Avalanche C-Chain + subnet archive). The
project is expected to run 1-2 months and produce a single PR or
discardable prototype, not a long-lived codebase.

This dir holds **only notes and process artifacts**, not code. External
code (avalanchego, subnet-evm, coreth, libevm, firewood, erigon, reth) is
referenced by absolute path. The goal is to compound knowledge across
sessions so we don't rediscover the same external-code facts and lose
architectural decisions every time context runs out.

The `~/experiments/` repo provides backup automatically — just commit
when you want a snapshot.

## External code paths

- `~/avalanchego` — consensus, ProposerVM, ChainVM interface, database layer
- `~/subnet-evm` — subnet EVM VM (configurable single-DB vs standalone)
- `~/coreth` — C-Chain EVM VM (always single-DB)
- `~/libevm` — Ava Labs' fork of go-ethereum (state, trie, rawdb)
- `~/firewood` — MPT state DB with revision sliding window
- `~/deforestationdb` — current prototype (executor + statedb)
- `/tmp/erigon` — reference for log indexes, seg compression, TxNum model
- `/tmp/reth` — reference for static-file (nippy-jar) columnar layout

When verifying a wiki claim, check that the cited file:line still exists
and means what we said. Code rots faster than docs.

## Folder taxonomy

| File / Dir | Lifecycle | Purpose |
|---|---|---|
| `plan.md` | mutable, edited-not-appended | Current architecture snapshot. 1-2 screens MAX. Loaded into every session. |
| `current.md` | mutable, rewritten on task switch | Single active task scratchpad. Loaded into every session. |
| `decisions.md` | append-only, never delete | Locked-in architecture decisions w/ rationale. Supersede via new entry. |
| `wiki/*.md` | mostly stable, citation-required | Facts about external code. One file per system or topic. |
| `ideas/*.md` | mutable | Non-final design content: speculative ideas, comparisons, tradeoff analyses, opinions on alternatives. Broader than the name. |
| `log/YYYY-MM-DD.md` | append-only per day | Summary-grade chronological log of session activity. |
| `templates/*.md` | stable | Skeletons to use when creating new entries. |

### What goes where (the easy-to-confuse cases)

- **`decisions.md` vs `ideas/`**: closed alternatives w/ rationale go in
  `decisions.md`. Open alternatives still being weighed go in `ideas/`.
  When an idea hardens into a decision, the decision entry links the
  idea file.
- **`wiki/` vs `ideas/`**: `wiki/` = facts about external code we don't
  own (citation-required). `ideas/` = our own design thinking.
- **`plan.md` vs `decisions.md`**: `plan.md` is *what* we're building
  right now. `decisions.md` is *why* we chose A over B.
- **`log/` vs full transcripts**: `log/` is summary-grade. Full session
  transcripts live at
  `~/.claude/projects/-home-ubuntu-experiments-2026-04-04_deforestationdb/`
  as JSONL — `grep` them if you need raw history.

### Studies during idea exploration → wiki entries

Idea-exploration often involves reading external source to verify how
something actually works (e.g., "does Firewood fsync between
checkpoints?"). When a verification study produces facts about external
code, those facts belong in **`wiki/`**, not buried inside the idea
file.

The pattern:
1. While exploring an idea, dispatch an investigation (Explore agent or
   direct reads) to verify some external-code behaviour.
2. The findings — what Firewood actually does, with file:line citations
   — are extracted into a new (or existing) `wiki/` entry.
3. The idea file is updated to **reference the wiki entry** for facts,
   and focuses on what those facts mean for our design.

This keeps facts reusable — the next idea/decision/task that needs to
know "how does Firewood persist?" reads the wiki entry directly,
without having to dig through an unrelated idea file.

When in doubt: if the content is "how external system X behaves," it's
wiki. If it's "given that, how should we design Y," it's idea.

## Naming conventions

- 4-6 words, kebab-case, descriptive. The filename IS the summary.
- Examples: `subnet-evm-database-layout.md`, `firewood-revision-window.md`,
  `txnum-vs-block-keying.md`, `erigon-vs-reth-compression.md`.
- Bad: `notes1.md`, `idea.md`, `tmp.md`.

## Auto-write rules — when the assistant proposes saving

The assistant always asks before writing. Default = ask, no silent file
creation. Prompts to listen for:

- **wiki entry** — when a non-trivial fact about external code is found
  (e.g., "Erigon's `LogTopicIdx` is position-agnostic, here's the file:line").
  Propose: "save this to `wiki/X.md`?"
- **idea** — when the user describes a design alternative we're weighing,
  or we run a comparison (e.g., "SST vs MPHF vs hashmap"). Propose:
  "save this to `ideas/X.md`?"
- **decision** — only on user request ("record this") or when we just
  closed off a real alternative. Propose: "record decision to `decisions.md`?"
- **log** — append at session end, or when user says "log it". One bullet
  per significant activity, prefixed with rough time.
- **current.md** — edit freely as the active task progresses; rewrite
  when a new task starts.

## Privileged docs

`plan.md` and `current.md` are loaded into every session by the
SessionStart hook. They MUST stay concise:
- 1-2 screens each (~80-150 lines).
- If either grows past 2 screens, refactor: move detail to `wiki/`,
  history to `log/`, alternatives to `ideas/`.
- The whole point is to fit them in fresh-session context cheaply.

When we make an architectural pivot, edit `plan.md` first, then update
the rest. `plan.md` is the source of truth for current direction.

## Hook behaviour

`.claude/session-start.sh` runs on every session start, resume, clear,
and post-compaction. It:

1. Auto-creates today's log file if missing.
2. Cats `plan.md` + `current.md`.
3. Lists filenames in `log/`, `wiki/`, `ideas/`.
4. Greps last 5 decision titles from `decisions.md`.

Output is injected as a system reminder. This is the main payoff —
context survives compaction.

## Wiki citation requirement

**Every wiki entry MUST cite source code that backs up its claims.**

- Each non-trivial assertion in a `wiki/` entry has at least one
  `path/to/file.ext:LINE` (or `:LINE-LINE`) reference next to it.
- Cite absolute paths from the project root of the system being
  documented (e.g., `db/state/statecfg/state_schema.go:332-345` for
  Erigon, `plugin/evm/vm_database.go:55-96` for subnet-evm).
- If a claim is empirical (a benchmark number, a runtime observation),
  cite the comment, README section, or test that records it.
- If a claim cannot be backed by a citation, it does not belong in
  `wiki/`. It goes in `ideas/` (with status: speculative) or stays out.
- Before adding a wiki entry, **verify each citation** by reading the
  cited file:line. If something has moved or changed, update the
  citation or drop the claim.

## Verification before recommendation

Wiki captures truth at write-time, not now-time. Before relying on a
wiki fact in a fresh recommendation:
- If naming a function / flag / path: re-grep the cited file:line to
  confirm it still exists and means what we said.
- If the user is about to act on the recommendation: verify first, then
  recommend.
- If the wiki entry's `Last verified` is more than a few weeks old and
  the claim is load-bearing for the next decision: re-verify and bump
  the date.

## Non-goals

- No commit automation. User commits when they want a snapshot.
- No remote push / external backup beyond what `~/experiments/` provides.
- No search engine. `ls` + descriptive filenames are enough at this scale.
- No CLAUDE.md in external code dirs. Only here.
- No raw conversation dumps. Transcripts already exist as JSONL.
