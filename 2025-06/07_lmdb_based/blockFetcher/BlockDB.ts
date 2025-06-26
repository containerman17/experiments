import Database from 'better-sqlite3';
import { StoredBlock } from './BatchRpc';
import { encodeLazyBlock, LazyBlock } from './LazyBlock';
import { encodeLazyTx, LazyTx } from './LazyTx';
import { compress as lz4Compress, uncompress as lz4Uncompress } from 'lz4-napi';

export class BlockDB {
    private db: InstanceType<typeof Database>;

    private prepped: Map<string, any>;
    private isWriter: boolean;

    constructor(path: string, isWriter: boolean) {
        this.db = new Database(path, {
            readonly: !isWriter,
        });
        this.isWriter = isWriter;
        this.initPragmas(isWriter);
        this.initSchema();
        this.prepped = new Map();
    }

    getLastStoredBlockNumber(): number {
        const selectMax = this.prepQuery('SELECT MAX(id) as max_id FROM blocks');
        const result = selectMax.get() as { max_id: number | null } | undefined;
        return result?.max_id ?? -1; // Return -1 if no blocks stored
    }

    storeBlocks(batch: StoredBlock[]) {
        if (!this.isWriter) throw new Error('BlockDB is not a writer');
        if (batch.length === 0) return;

        let lastStoredBlockNum = this.getLastStoredBlockNumber();

        const insertMany = this.db.transaction((batch: StoredBlock[]) => {
            for (let i = 0; i < batch.length; i++) {
                const block = batch[i]!;
                if (Number(block.block.number) !== lastStoredBlockNum + 1) {
                    throw new Error(`Batch not sorted or has gaps: expected ${lastStoredBlockNum + 1}, got ${block.block.number}`);
                }
                this.storeBlock(block);
                lastStoredBlockNum++;
            }
        });
        insertMany(batch);
    }

    async getBlock(n: number): Promise<LazyBlock> {
        const selectBlock = this.prepQuery('SELECT data FROM blocks WHERE id = ?');
        const result = selectBlock.get(n) as { data: Buffer } | undefined;
        if (!result) throw new Error(`Block ${n} not found`);

        // Decompress the data
        const decompressedData = await lz4Uncompress(result.data);
        return new LazyBlock(decompressedData);
    }

    async getTx(n: number, ix: number): Promise<LazyTx> {
        const selectTx = this.prepQuery('SELECT data FROM txs WHERE block_id = ? AND tx_ix = ?');
        const result = selectTx.get(n, ix) as { data: Buffer } | undefined;
        if (!result) throw new Error(`Tx ${n}:${ix} not found`);

        // Decompress the data
        const decompressedData = await lz4Uncompress(result.data);
        return new LazyTx(decompressedData);
    }

    setBlockchainLatestBlockNum(blockNumber: number) {
        if (!this.isWriter) throw new Error('BlockDB is not a writer');
        const upsert = this.prepQuery('INSERT OR REPLACE INTO kv_int (key, value) VALUES (?, ?)');
        upsert.run('blockchain_latest_block', blockNumber);
    }

    getBlockchainLatestBlockNum(): number {
        const select = this.prepQuery('SELECT value FROM kv_int WHERE key = ?');
        const result = select.get('blockchain_latest_block') as { value: number } | undefined;
        return result?.value ?? -1;
    }

    close() {
        this.db.close();
    }

    private prepQuery(query: string) {
        if (this.prepped.has(query)) return this.prepped.get(query)!;
        const prepped = this.db.prepare(query);
        this.prepped.set(query, prepped);
        return prepped;
    }

    private async storeBlock(b: StoredBlock) {
        const insertBlock = this.prepQuery('INSERT INTO blocks(id, data) VALUES (?, ?)');
        const insertTx = this.prepQuery('INSERT INTO txs(block_id, tx_ix, data) VALUES (?, ?, ?)');

        const blockNumber = Number(b.block.number);

        // Compress block data before storing
        const blockData = encodeLazyBlock(b.block);
        const compressedBlockData = await lz4Compress(Buffer.from(blockData));
        insertBlock.run(blockNumber, compressedBlockData);

        for (let i = 0; i < b.block.transactions.length; ++i) {
            const tx = b.block.transactions[i]!;
            const receipt = b.receipts[tx.hash];
            if (!receipt) throw new Error(`Receipt not found for tx ${tx.hash}`);

            // Compress transaction data before storing
            const txData = encodeLazyTx(tx, receipt);
            const compressedTxData = await lz4Compress(Buffer.from(txData));
            insertTx.run(blockNumber, i, compressedTxData);
        }
    }

    private initSchema() {
        if (!this.isWriter) return;
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        id   INTEGER PRIMARY KEY,
        data BLOB NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS txs (
        block_id INTEGER NOT NULL,
        tx_ix    INTEGER NOT NULL,
        data     BLOB NOT NULL,
        PRIMARY KEY (block_id, tx_ix)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS kv_int (
        key   TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) WITHOUT ROWID;
    `);
    }

    private initPragmas(isWriter: boolean) {
        // 8 KiB pages = good balance for sequential writes & mmap reads
        this.db.pragma('page_size = 8192');

        if (isWriter) {
            // *** WRITER: fire-and-forget speed ***
            this.db.pragma('journal_mode      = WAL');         // enables concurrent readers
            this.db.pragma('synchronous       = OFF');         // lose at most one commit on crash
            this.db.pragma('wal_autocheckpoint = 20000');      // ~80 MB before checkpoint pause
            this.db.pragma('mmap_size         = 0');           // writer gains nothing from mmap
            this.db.pragma('cache_size        = -262144');     // 256 MiB page cache
            this.db.pragma('temp_store        = MEMORY');      // keep temp B-trees off disk
        } else {
            // *** READER: turbo random look-ups ***
            this.db.pragma('query_only         = TRUE');       // hard-lock to read-only
            this.db.pragma('read_uncommitted   = TRUE');       // skip commit window wait
            this.db.pragma('mmap_size          = 1099511627776'); // 1 TB
            this.db.pragma('cache_size         = -1048576');   // 1 GiB page cache
            this.db.pragma('busy_timeout       = 0');          // fail fast if writer stalls
        }
    }
}
