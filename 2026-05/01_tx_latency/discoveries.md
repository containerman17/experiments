# Transaction Latency Notes

- Benchmark goal: measure time from local transaction submission to chain inclusion.
- Use pre-signed raw EVM transactions and send them with plain JSON-RPC HTTP.
- Fanout of the same signed transaction to many RPCs does not multiply gas cost; only one transaction can be included.
- Main metric: `included_block.timestampMilliseconds - local_submit_wall_clock_ms`.
- Receipt polling is only needed to discover the included block hash/number; exact receipt fetch timing is not required for inclusion latency.
- Still useful to log RPC send ack times and receipt observation time as diagnostics.
- AvalancheGo/Subnet-EVM RPC block responses expose `timestampMilliseconds` as a hex quantity. Treat it as required for this benchmark and fail fast if absent.
- Optional transaction `data` can tag benchmark txs, e.g. `txlat:v1`, but it is public and costs extra gas.
- At 1 tx every 5 seconds for 3 hours: `2160` txs.
- With cost `0.00000016392978 AVAX` per tx, the 3 hour run burns about `0.0003540883248 AVAX`.
- A single account has nonce coupling: if one tx gets stuck, later transactions queue behind it and distort measurements.
