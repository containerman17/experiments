import Database from 'better-sqlite3';
import { Block, Transaction } from './evmTypes';
import { StoredBlock } from './BatchRpc';
import { QueryPrepper } from '../utils/prepQuery';

export class BlockDB {
    private db: Database;

    private prepper: QueryPrepper;

    constructor(path: string) {
        this.db = new Database(path);
        this.initPragmas();
        this.initSchema();
        this.prepper = new QueryPrepper(this.db);
    }

    /* ---------- public API ---------- */

    storeBlocks(batch: StoredBlock[]) {
        const insertMany = this.db.transaction((blocks: StoredBlock[]) => {
            for (const b of blocks) this.storeBlock(b);
        });
        insertMany(batch);
    }

    getBlock(n: number): Block {
        const selectBlock = this.prepper.prepare('SELECT data FROM blocks WHERE id = ?').pluck();
        const buf = selectBlock.get(n) as Buffer | undefined;
        if (!buf) throw new Error(`Block ${n} not found`);
        return decodeBlock(buf);
    }

    getTx(n: number, ix: number): Transaction {
        const selectTx = this.prepper.prepare('SELECT data FROM txs WHERE block_id = ? AND tx_ix = ?').pluck();
        const buf = selectTx.get(n, ix) as Buffer | undefined;
        if (!buf) throw new Error(`Tx ${n}:${ix} not found`);
        return decodeTx(buf);
    }

    close() {
        this.db.close();
    }

    /* ---------- internals ---------- */

    private storeBlock(b: StoredBlock) {
        const insertBlock = this.prepper.prepare('INSERT INTO blocks(id, data) VALUES (?, ?)');
        const insertTx = this.prepper.prepare('INSERT INTO txs(block_id, tx_ix, data) VALUES (?, ?, ?)');

        const blockNumber = Number(b.block.number);

        insertBlock.run(blockNumber, encodeBlock(b.block));
        for (let i = 0; i < b.block.transactions.length; ++i) {
            insertTx.run(blockNumber, i, encodeTx(b.block.transactions[i]));
        }
    }

    private initSchema() {
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
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous  = NORMAL');
        this.db.pragma('mmap_size    = 1073741824'); // 1 GiB
        this.db.pragma('cache_size   = -1048576'); // 1 GiB
    }
}

/* ---------- stubs ---------- */
function encodeBlock(b: Block): Buffer {
    throw new Error('not impl');
}
function encodeTx(t: Transaction): Buffer {
    throw new Error('not impl');
}
function decodeBlock(b: Buffer): Block {
    throw new Error('not impl');
}
function decodeTx(b: Buffer): Transaction {
    throw new Error('not impl');
}
