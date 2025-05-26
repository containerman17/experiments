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

INSERT OR IGNORE INTO configs (key, value) VALUES ('last_processed_block', '-1');
