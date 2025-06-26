import Database from 'better-sqlite3';
import { StoredBlock } from './BatchRpc';
import { encodeLazyBlock, LazyBlock } from './LazyBlock';
import { encodeLazyTx, LazyTx } from './LazyTx';

export class BlockDB {
    private db: InstanceType<typeof Database>;

    private prepped: Map<string, any>;
    private isWriter: boolean;

    constructor(path: string, isWriter: boolean) {
        this.db = new Database(path, {
            readonly: !isWriter,
        });
        this.initPragmas();
        this.initSchema();
        this.prepped = new Map();
        this.isWriter = isWriter;
    }

    getLastStoredBlockNumber(): number {
        const selectMax = this.prepQuery('SELECT MAX(id) as max_id FROM blocks');
        const result = selectMax.get() as { max_id: number | null } | undefined;
        return result?.max_id ?? -1; // Return -1 if no blocks stored
    }

    storeBlocks(batch: StoredBlock[]) {
        if (!this.isWriter) throw new Error('BlockDB is not a writer');
        if (batch.length === 0) return;

        const insertMany = this.db.transaction((batch: StoredBlock[]) => {
            let lastStoredBlockNum = this.getLastStoredBlockNumber();

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

    getBlock(n: number): LazyBlock {
        const selectBlock = this.prepQuery('SELECT data FROM blocks WHERE id = ?');
        const result = selectBlock.get(n) as { data: Buffer } | undefined;
        if (!result) throw new Error(`Block ${n} not found`);
        return new LazyBlock(result.data);
    }

    getTx(n: number, ix: number): LazyTx {
        const selectTx = this.prepQuery('SELECT data FROM txs WHERE block_id = ? AND tx_ix = ?');
        const result = selectTx.get(n, ix) as { data: Buffer } | undefined;
        if (!result) throw new Error(`Tx ${n}:${ix} not found`);
        return new LazyTx(result.data);
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

    private storeBlock(b: StoredBlock) {
        const insertBlock = this.prepQuery('INSERT INTO blocks(id, data) VALUES (?, ?)');
        const insertTx = this.prepQuery('INSERT INTO txs(block_id, tx_ix, data) VALUES (?, ?, ?)');

        const blockNumber = Number(b.block.number);

        insertBlock.run(blockNumber, encodeLazyBlock(b.block));
        for (let i = 0; i < b.block.transactions.length; ++i) {
            const tx = b.block.transactions[i]!;
            const receipt = b.receipts[tx.hash];
            if (!receipt) throw new Error(`Receipt not found for tx ${tx.hash}`);
            insertTx.run(blockNumber, i, encodeLazyTx(tx, receipt));
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
    `);
    }

    private initPragmas() {
        this.db.pragma('page_size = 8192'); // 8 KiB

        if (this.isWriter) {
            // Writer connection pragmas
            this.db.pragma('journal_mode = WAL');          // enables concurrent read-write
            this.db.pragma('synchronous  = NORMAL');       // good durability/latency trade-off
            this.db.pragma('wal_autocheckpoint = 10000');  // ~10 MB WAL before auto-checkpoint
            this.db.pragma('mmap_size    = 1073741824');   // 1 GiB virtual map (harmless)
            this.db.pragma('cache_size   = -262144');      // 256 MiB page cache is enough here
        } else {
            // Reader connection pragmas
            this.db.pragma('query_only      = TRUE');      // belt-and-suspenders read-only
            this.db.pragma('read_uncommitted= TRUE');      // see new pages sooner, still safe in WAL
            this.db.pragma('mmap_size       = 1073741824');// map reads straight from the file
            this.db.pragma('cache_size      = -1048576');  // give the reader the big cache (1 GiB)
        }
    }
}
