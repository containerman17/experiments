# ClickHouse Native vs Parquet - Local Comparison

Export raw_logs for Jan-Apr 2025 to Parquet (one file per month):

```bash
mkdir -p ./data/parquet_logs
clickhouse-client --query="SELECT * FROM raw_logs WHERE block_time >= '2025-01-01' AND block_time < '2025-02-01' FORMAT Parquet" > ./data/parquet_logs/logs_2025_01.parquet
clickhouse-client --query="SELECT * FROM raw_logs WHERE block_time >= '2025-02-01' AND block_time < '2025-03-01' FORMAT Parquet" > ./data/parquet_logs/logs_2025_02.parquet
clickhouse-client --query="SELECT * FROM raw_logs WHERE block_time >= '2025-03-01' AND block_time < '2025-04-01' FORMAT Parquet" > ./data/parquet_logs/logs_2025_03.parquet
clickhouse-client --query="SELECT * FROM raw_logs WHERE block_time >= '2025-04-01' AND block_time < '2025-05-01' FORMAT Parquet" > ./data/parquet_logs/logs_2025_04.parquet
```

Export same data in Native format with zstd compression:

```bash
mkdir -p ./data/native_zstd
clickhouse-client --query="SELECT * FROM raw_logs WHERE block_time >= '2025-01-01' AND block_time < '2025-02-01' FORMAT Native" | zstd > ./data/native_zstd/logs_2025_01.native.zst
clickhouse-client --query="SELECT * FROM raw_logs WHERE block_time >= '2025-02-01' AND block_time < '2025-03-01' FORMAT Native" | zstd > ./data/native_zstd/logs_2025_02.native.zst
clickhouse-client --query="SELECT * FROM raw_logs WHERE block_time >= '2025-03-01' AND block_time < '2025-04-01' FORMAT Native" | zstd > ./data/native_zstd/logs_2025_03.native.zst
clickhouse-client --query="SELECT * FROM raw_logs WHERE block_time >= '2025-04-01' AND block_time < '2025-05-01' FORMAT Native" | zstd > ./data/native_zstd/logs_2025_04.native.zst
```

## Results - Storage Size

```
6.9G    ./data/parquet_logs
6.8G    ./data/native_zstd
```

Almost identical. Both can be queried directly:

```sql
SELECT * FROM file('./data/native_zstd/logs_2025_01.native.zst', 'Native', 'zstd')
SELECT * FROM file('./data/parquet_logs/logs_2025_01.parquet', 'Parquet')
```

## Query Performance Comparison

Query: Top 3 contracts by ERC-20 Transfer events (2.6B rows, 1.1B matching)

### Bug: clickhouse-local unhex() comparison with Parquet

`unhex()` comparison against FixedString columns from Parquet returns wrong results:

```sql
-- WRONG (returns ~520M instead of 1.1B)
WHERE topic0 = unhex('ddf252ad...')

-- CORRECT (returns 1.1B)
WHERE hex(topic0) = 'DDF252AD...'
```

### Results - Unlimited threads

| Source | Real time | CPU time |
|--------|-----------|----------|
| Parquet (clickhouse-local) | 7.8s | 4m30s |
| ClickHouse server | 2.5s | server-side |

### Results - 8 threads (fair comparison)

| Source | Real time | CPU time |
|--------|-----------|----------|
| Parquet (clickhouse-local, max_threads=8) | 7.4s | 4m0s |
| ClickHouse server (max_threads=8) | 7.6s | server-side |

### Key findings

1. **Same speed with equal threads** - With 8 threads, both ~7.5s
2. **ClickHouse faster with more cores** - 2.5s vs 7.5s (unlimited threads)
3. **MergeTree index doesn't help here** - table ORDER BY is `(chain_id, block_time, address, topic0)`, topic0 is last so full scan required
4. **Parquet uses ~35 cores** - 270s CPU / 7.8s wall = 35x parallelism
5. **I/O bound, not CPU bound** - limiting threads from unlimited to 8 didn't change wall time much

### Native+zstd vs Parquet (clickhouse-local)

Native+zstd is much slower because it's row-based - must decompress all columns:

| Format | Real time |
|--------|-----------|
| Parquet | 2.0s |
| Native+zstd | 14.6s |

Parquet is columnar - only reads `address` and `topic0` columns.

## UInt256 Sum Benchmark

Query: Sum all Transfer values for contract B97EF9EF8734C71904D8002F8B6BC66DD9C48A6E

```sql
SELECT 
    sum(reinterpretAsUInt256(reverse(data))) as total_value,
    count() as transfers
FROM raw_logs 
WHERE topic0 = unhex('ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
  AND address = unhex('B97EF9EF8734C71904D8002F8B6BC66DD9C48A6E')
  AND length(data) = 32
```

Result: **996,316,724,648,122,339** total value across **219,699,632** transfers

### Results

| Source | Threads | Real time | CPU time |
|--------|---------|-----------|----------|
| ClickHouse | unlimited | 6.5s | server-side |
| ClickHouse | 8 | 19.8s | server-side |
| Parquet | unlimited | 28.6s | 10m33s |
| Parquet | 8 | 29.6s | 9m50s |

### Key findings

1. **ClickHouse benefits heavily from parallelism** - 6.5s → 19.8s when limited to 8 threads
2. **Parquet is I/O bound** - limiting threads barely changes wall time (28.6s → 29.6s)
3. **UInt256 + byte reversal works correctly** - results match between both sources
4. **ClickHouse 4-5x faster** - even with unlimited threads, ClickHouse wins on this compute-heavy query

## FixedString Benchmark

Query: Top senders by event count (GROUP BY tx_from FixedString(20))

```sql
SELECT 
    hex(tx_from) as sender,
    count() as events
FROM raw_logs 
GROUP BY tx_from
ORDER BY events DESC
LIMIT 10
```

### Results

| Source | Threads | Real time | CPU time |
|--------|---------|-----------|----------|
| ClickHouse | unlimited | 2.1s | server-side |
| ClickHouse | 8 | 6.4s | server-side |
| Parquet | unlimited | 5.7s | 2m25s |
| Parquet | 8 | 7.1s | 1m39s |

### Key findings

1. **With 8 threads, very close** - 6.4s vs 7.1s
2. **FixedString overhead is minimal** - Parquet stores fixed-length binary as `FIXED_LEN_BYTE_ARRAY`, similar to ClickHouse's FixedString
3. **Main ClickHouse advantage is parallelism** - 2.1s with unlimited threads vs 5.7s for Parquet

## Index/Sparse Query Benchmark

Query: Find specific contract's Approval events across ALL data (selective filter using index columns)

```sql
SELECT count(), min(block_time), max(block_time)
FROM raw_logs 
WHERE chain_id = 43114
  AND address = unhex('B97EF9EF8734C71904D8002F8B6BC66DD9C48A6E')
  AND topic0 = unhex('8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925')
```

Result: 15,405,755 events found

### Results

| Source | Threads | Real time |
|--------|---------|-----------|
| ClickHouse | unlimited | **2.7s** |
| ClickHouse | 8 | 7.9s |
| Parquet | unlimited | 13.3s |
| Parquet | 8 | 12.6s |

### Additional selective queries tested

| Query | ClickHouse | Parquet |
|-------|------------|---------|
| Narrow time range (1 hour) | 0.098s | 0.373s |
| Point lookup (exact timestamp) | 0.085s | 0.250s |
| Filter by address across all data | 1.6s | 4.6s |
| Chain + month + address | 0.160s | 0.376s |

### Key findings

1. **ClickHouse 5x faster on sparse queries** - Index on `(chain_id, block_time, address, topic0)` allows skipping granules
2. **Parquet must full-scan** - Row group statistics help with time ranges but can't skip based on address/topic0
3. **Monthly partitioning helps Parquet** - Queries limited to one month are closer in performance
4. **Index advantage persists with limited threads** - Even at 8 threads, ClickHouse wins (7.9s vs 12.6s)

## Worst Case Analysis - Trying to Break Parquet

Attempted to find queries where Parquet performs 20x worse. Result: Parquet is remarkably resilient.

### Queries tested

| Query Type | ClickHouse | Parquet | Ratio |
|------------|------------|---------|-------|
| Sparse index query (address+topic0) | 2.7s | 13.3s | **5x** |
| UInt256 sum (compute heavy) | 6.5s | 28.6s | **4.4x** |
| High-cardinality GROUP BY on String | 9.2s | 27.7s | **3x** |
| Quantiles per contract | 10s | 28s | **2.8x** |
| Point lookup (tx_hash, not indexed) | 2.9s | 9.2s | **3.2x** |
| Heavy String operations on data field | 4.6s | 12.6s | **2.7x** |
| SELECT * (all columns) | 0.11s | 0.24s | **2.2x** |
| Self-join | 2.4s | 2.7s | **1.1x** |
| Window function | 0.18s | 0.44s | **2.4x** |
| arrayJoin on topics | 0.18s | 0.42s | **2.3x** |

### Why Parquet doesn't get destroyed

1. **Excellent columnar compression** - only reads needed columns
2. **Row group statistics** - enables predicate pushdown on time ranges
3. **Monthly file partitioning** - narrows scans to relevant files
4. **Modern hardware** - NVMe + many cores = IO bottleneck, not format overhead
5. **ClickHouse Parquet reader is well-optimized** - parallel reading, vectorized execution

### Conclusion

- **Realistic penalty: 3-5x** for most analytical workloads
- **Worst case: 5x** on sparse index queries (ClickHouse can skip data, Parquet cannot)
- **Best case for Parquet: ~1x** on JOINs and simple aggregations
- **Parquet is a viable format** for cold storage / data lake with acceptable query performance

## S3 Benchmark (Local MinIO)

Setup: MinIO serving Parquet files locally, ClickHouse server querying via `s3()` function.

### S3 Cache Configuration

```xml
<filesystem_caches>
    <s3_cache>
        <path>/root/experiments/.../cache/s3_cache/</path>
        <max_size>100Gi</max_size>
    </s3_cache>
</filesystem_caches>
```

### Local File vs S3 vs S3+Cache (clickhouse-local)

| Source | Time | Notes |
|--------|------|-------|
| Direct local file | 7.9s | Baseline |
| S3 (warm cache) | 7.9s | Same as local (MinIO on same NVMe) |
| S3 (no cache) | 8.5s | ~0.6s S3 overhead |

**Finding**: Local MinIO has negligible overhead since it's on the same disk.

### ClickHouse Server vs S3 Parquet (server-side)

| Source | Time | Notes |
|--------|------|-------|
| clickhouse-local (S3) | ~8s | New process each time |
| clickhouse-client → server (S3) | ~3.6s | Server page cache |
| clickhouse-client → server (MergeTree) | ~2.6s | Native storage |

**Finding**: Use ClickHouse server for S3 queries - it maintains page cache.

### Worst Case Re-test: MergeTree vs S3 Parquet

Query 1: Sparse index query (chain_id + address + topic0)

| Source | Time | Ratio |
|--------|------|-------|
| ClickHouse MergeTree | **3.3s** | 1x |
| S3 Parquet (server, warm) | 14.3s | **4.4x** |

Query 2: UInt256 sum (compute heavy, full scan)

| Source | Time | Ratio |
|--------|------|-------|
| ClickHouse MergeTree | **10.0s** | 1x |
| S3 Parquet (server, warm) | 33.2s | **3.3x** |

### S3 Cache Inspection

Cache stores Parquet row groups by byte offset:
```
./cache/s3_cache/f44/f44a86862a5c2381d9765e5081b549dd/
├── 0           (4MB - header)
├── 90022622    (13MB - row group)
├── 124330691   (13MB - row group)
└── ...         (50 files, 586MB total for one .parquet)
```

### S3 Conclusion

- **S3 overhead is minimal** with local MinIO (~0.6s)
- **Server caching helps** - 8s (clickhouse-local) → 3.6s (server)
- **MergeTree still wins** - 3-4x faster than S3 Parquet even with warm cache
- **Real S3 would show bigger cache benefits** due to network latency
