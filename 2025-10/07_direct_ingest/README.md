# Metrics API on ClickHouse

## Prerequisites

### ClickHouse Installation

Install ClickHouse natively or with Docker. ClickHouse Cloud is untested and might work, but not recommended.

**Installation guide:** https://clickhouse.com/docs/install

### **IMPORTANT: Set Timezone to UTC**

ClickHouse must be configured to use UTC timezone.

**For Docker installations:**
- Modify `/etc/clickhouse-server/config.xml` inside the container and add:
  ```xml
  <timezone>UTC</timezone>
  ```
- Or set environment variable when running container:
  ```bash
  docker run -e TZ=UTC clickhouse/clickhouse-server
  ```

**For native installations:**
- Edit `/etc/clickhouse-server/config.xml` and add `<timezone>UTC</timezone>` under the `<clickhouse>` section

### Authentication Setup

For local development, running ClickHouse without a password is recommended.

If you need password authentication (for user `default` and database `default`):
```bash
export CLICKHOUSE_PASSWORD=your_password
```

The application will pick up this environment variable automatically.

**Quick connection test:**
```bash
clickhouse-client "select 1"
```

This should execute without any additional arguments or password prompts.

## Configuration

Edit `config.json` to configure your blockchain ingestion:

```json
[
    {
        "chainID": 43114,
        "rpcURL": "http://localhost:9650/ext/bc/C/rpc",
        "startBlock": 69600000,
        "fetchBatchSize": 400,
        "maxConcurrency": 100
    }
]
```

### Configuration Parameters

- **`chainID`** (required): Chain identifier (e.g., 43114 for Avalanche C-Chain)
- **`rpcURL`** (required): **Replace this with your actual RPC endpoint URL**
- **`startBlock`** (optional): Block number to start ingestion from on first run. If omitted, starts from block 1. On subsequent runs, always resumes from the last synced block (watermark)
- **`fetchBatchSize`** (optional): Number of blocks to fetch in each batch. Default: 400
- **`maxConcurrency`** (optional): Maximum concurrent RPC requests. Default: 100

You can configure multiple chains by adding more objects to the array.

## Running the Application

### Commands

#### `ingest` - Start Ingestion (Main Command)

This is the primary command you'll use. It starts the continuous ingestion process that syncs blockchain data into ClickHouse:

```bash
go run . ingest
```

The ingester will:
- Create all necessary tables automatically
- Resume from the last synced block
- Continuously fetch and process new blocks
- Calculate metrics on schedule when enough data is ingested

#### `size` - Show Table Sizes

Display ClickHouse table sizes and disk usage statistics:

```bash
go run . size
```

This shows:
- All tables with row counts and sizes in MB
- RPC cache directory sizes

#### `wipe` - Drop Tables

Drop calculated/derived tables (keeps raw data and watermark):

```bash
go run . wipe
```

To drop ALL tables including raw data:

```bash
go run . wipe --all
```

## Querying Data

### Using clickhouse-client

Query your ingested data directly from the command line:

```bash
# Query hourly ICM sent messages
clickhouse-client "SELECT period, value FROM icm_sent_hour LIMIT 10"

# Query raw blocks
clickhouse-client "SELECT block_number, block_time, hex(hash) as hash, hex(parent_hash) as parent_hash, gas_used, gas_limit FROM raw_blocks ORDER BY block_number DESC LIMIT 5"

# Query raw transactions
clickhouse-client "SELECT block_number, transaction_index, hex(hash) as hash, hex(\`from\`) as from, hex(to) as to, value, gas_used FROM raw_transactions LIMIT 10"

# Count total transactions
clickhouse-client "SELECT count() FROM raw_transactions"

# Check sync status
clickhouse-client "SELECT * FROM sync_watermark"
```

### Using DBeaver

For a GUI interface, connect to ClickHouse using DBeaver:

1. Install DBeaver and add a ClickHouse connection
2. Connection settings:
   - **Protocol**: HTTP
   - **Host**: `localhost`
   - **Port**: `8123` (default HTTP port)
   - **Database**: `default`
   - **User**: `default`
   - **Password**: (leave empty if no password set)

DBeaver provides a rich interface for exploring tables, writing queries, and visualizing results.

## Metrics & Analytics

For detailed information about available metrics, aggregated tables, and analytical queries, see:

**[sql/metrics/README.md](sql/metrics/README.md)**


## Architecture

- **Raw Tables**: Store blockchain data as-is (`raw_blocks`, `raw_transactions`, `raw_traces`, `raw_logs`)
- **Calculated Tables**: Derived metrics and aggregations built from raw data
- **RPC Cache**: Local disk cache to speed up resync (will be removed in production)

## Troubleshooting

**Connection issues:**
- Verify ClickHouse is running and available without password: `clickhouse-client "SELECT 1"`
- Check timezone configuration with: `clickhouse-client "SELECT timezone()"` (has to be UTC)
- Ensure port 9000 (native) or 8123 (HTTP) is accessible

**RPC Performance:**
- Adjust `maxConcurrency` if your RPC endpoint has rate limits
- Reduce `fetchBatchSize` if you see no visual progress

**Data issues:**
- Use `wipe` to reset calculated tables while keeping raw data
- Check `sync_watermark` table to see ingestion progress
- Review logs for any RPC errors or connection issues

