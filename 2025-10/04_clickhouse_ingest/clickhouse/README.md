# ClickHouse Integration

All ClickHouse-related logic is contained in this folder.

## Files

- `structure.sql` - Database schema for the logs table
- `client.ts` - ClickHouse client wrapper with insert and query methods
- `transformations.ts` - Transforms ArchivedBlock data into log rows

## Setup

1. Create the database schema:
```bash
clickhouse-client < clickhouse/structure.sql
```

2. Configure environment variables (copy `.env.example` to `.env`):
```
CLICKHOUSE_HOST=http://localhost:8123
CLICKHOUSE_DATABASE=default
CLICKHOUSE_USER=
CLICKHOUSE_PASSWORD=
```

3. Run the reader to ingest blocks:
```bash
node reader.ts
```

## How it works

The reader:
1. Queries the database for the last ingested block number
2. Starts reading from that block
3. Transforms blocks into log rows using `transformBlockToLogs()`
4. Buffers logs in memory (max 10,000 rows)
5. Commits to database every second
6. Pauses reads when buffer is full to prevent memory overflow

