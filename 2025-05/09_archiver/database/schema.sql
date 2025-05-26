PRAGMA page_size = 4096;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = OFF;
PRAGMA cache_size = -64000;
PRAGMA wal_autocheckpoint = 10000;
PRAGMA checkpoint_fullfsync = OFF;

CREATE TABLE IF NOT EXISTS tx_block_lookup (
    hash_to_block BLOB PRIMARY KEY
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS configs (
    key TEXT PRIMARY KEY, 
    value TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tx_counts_hourly (
    hour_bucket INTEGER PRIMARY KEY,
    tx_count INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tx_counts_daily (
    day_bucket INTEGER PRIMARY KEY,
    tx_count INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

INSERT OR IGNORE INTO configs (key, value) VALUES ('last_processed_block', '-1');
