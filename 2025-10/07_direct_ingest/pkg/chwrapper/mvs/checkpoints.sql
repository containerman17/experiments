-- Track the last copied position based on insertion time
CREATE TABLE IF NOT EXISTS checkpoints (
    table_name String,
    last_inserted_at DateTime64(3),
) ENGINE = EmbeddedRocksDB
PRIMARY KEY table_name