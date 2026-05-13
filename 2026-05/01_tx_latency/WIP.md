# WIP: Avalanche C-Chain Inclusion Latency Service

## Goal

Build a minimal Go service that repeatedly sends benchmark transactions on Avalanche mainnet C-Chain and exposes aggregate results to Grafana via Prometheus metrics.

## Decisions

- Language: Go.
- Config: load `.env` with `godotenv`; read `PRIVATE_KEY` from env.
- Network: Avalanche C-Chain mainnet, chain ID `43114`.
- Transport: plain HTTPS JSON-RPC.
- Endpoints: use open unauthenticated endpoints collected in `endpoints.md`.
- Transaction: zero-value self-transfer from the configured private key back to its own address.
- Calldata: ASCII marker, e.g.

```text
benchmark=inclusion-latency tx_sign_ts=1234567890 region=nrt
```

- `region` is just a local config label for this process instance. There is no cross-machine coordination.
- Signing latency is acceptable noise; target is roughly `1500ms` p50 and `2500ms` p95.
- Inclusion latency metric:

```text
block.timestampMilliseconds - tx_sign_ts
```

- `timestampMilliseconds` is required. If an RPC block response lacks it, fail/skip that endpoint rather than falling back.
- Per-tx details should be printed with `fmt.Printf`, not exposed as Prometheus labels.
- Prometheus labels must stay low-cardinality. Do not label metrics by tx hash or nonce.

## Service Behavior

1. Start HTTP server exposing `/metrics`.
2. Load private key and derive sender address.
3. Periodically check wallet balance.
4. On each interval:
   - compute `tx_sign_ts = now unix ms`
   - build calldata with benchmark marker, timestamp, and region
   - sign a zero-value self-transfer
   - remember tx hash in memory
   - fan out `eth_sendRawTransaction` to configured endpoints
5. Independently scan new blocks:
   - call `eth_getBlockByNumber`
   - inspect transaction hashes
   - if a tracked tx hash is found, fetch receipt
   - compute inclusion latency from block `timestampMilliseconds`
   - update metrics
   - print tx details with `fmt.Printf`

## Metrics

Expose Prometheus metrics:

```text
txlat_inclusion_latency_seconds histogram {region, chain_id}
txlat_transactions_total counter {region, chain_id, status}
txlat_receipts_total counter {region, chain_id, status}
txlat_pending_transactions gauge {region, chain_id}
txlat_wallet_balance_avax gauge {region, address, chain_id}
txlat_estimated_txs_remaining gauge {region, address, chain_id}
txlat_rpc_request_duration_seconds histogram {endpoint, method}
txlat_rpc_requests_total counter {endpoint, method, result}
txlat_latest_block_number gauge {region, chain_id}
txlat_up gauge {region, chain_id}
```

Suggested inclusion latency buckets:

```text
0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 7.5, 10
```

## Printf Tx Details

Each completed tx should print one structured-ish line with:

```text
region
tx_hash
nonce
tx_sign_ts
block_number
block_timestamp_ms
inclusion_latency_ms
receipt_status
gas_used
effective_gas_price
fee_wei
fee_avax
```

## Open Implementation Notes

- One process should use one account. Do not share a nonce stream across machines.
- The simplest interval can be 1 tx per second or 1 tx per minute, configurable by env.
- Start with a single scanner endpoint from the working list, or rotate among endpoints with `timestampMilliseconds`.
- Sending fanout may return duplicate/known errors; those should be logged as RPC diagnostics, not treated as tx failure if at least one endpoint accepted or the tx later appears on-chain.
- Balance can be refreshed every 30-60 seconds.
