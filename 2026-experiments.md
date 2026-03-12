# 2026 Experiments

## January 2026

### 01_transplant_evm_state
Research and testing suite for transplanting EVM state between two Avalanche L1 chains with different Avalanche chain IDs but identical genesis configuration. Tests whether native ETH and ERC20 contract state can be migrated from testnet to mainnet without data loss.

**Tech:** Go, Bash, Solidity, Avalanche, Subnet-EVM

### 02_native_vs_parquet
Performance benchmarking of ClickHouse native format vs Parquet format for large-scale log data storage and querying (2.6B rows of blockchain transaction logs).

**Key findings:**
- Storage size nearly identical (~6.8–6.9 GB for 4 months)
- ClickHouse 5x faster on sparse index queries (2.7s vs 13.3s)
- Parquet performance penalty: 3–5x for typical analytical workloads

**Tech:** ClickHouse, Parquet, S3/MinIO

## February 2026

### 01_teleclaude
Telegram chatbot that controls Claude AI agents via the Claude Agent SDK. Supports multiple independent bot instances, voice transcription via Gemini, and auto-respawn on process failure.

**Tech:** TypeScript, Bun, Telegram.js, Claude Agent SDK

### 02_repricing
Empirical analysis of repricing EVM opcodes (`SSTORE`, `CREATE2`) to suppress state expansion and XEN Crypto spam on the Avalanche C-Chain. XEN contract footprint: 227M storage slots (34% of all C-Chain state).

**Tech:** Go, libevm (patched), Solidity, JSON-RPC

### 03_fancy_ui
Full-stack web UI for controlling multiple AI coding agents (Claude Code, Codex, Gemini) via the Agent Client Protocol (ACP). Real-time diff streaming, terminal emulation, voice recording, and cross-tab WebSocket synchronization.

**Tech:** React, TypeScript, Node.js, WebSockets, SQLite, Cloudflare Pages
