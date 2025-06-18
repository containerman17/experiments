import SQLite from 'better-sqlite3';
import { StoredBlock } from '../rpc/BatchRpc';
import { compress, decompress } from '../lib/compressor/compressor';
import { DEFAULT_PRAGMAS } from './pragmas';


const createSQL = `
PRAGMA page_size = 4096;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = OFF;
PRAGMA cache_size = -64000;
PRAGMA wal_autocheckpoint = 10000;
PRAGMA checkpoint_fullfsync = OFF;

CREATE TABLE IF NOT EXISTS blocks (
	block_number INTEGER PRIMARY KEY,
	data BLOB NOT NULL
);
`

export class SqliteBlockStore {
    constructor(protected db: SQLite.Database) { }

    public initialize() {
        this.db.exec(DEFAULT_PRAGMAS)
        this.db.exec(createSQL)
        this.db.pragma('optimize')
    }

    public async getBlocks(blockNumbers: number[]): Promise<{ blocks: (StoredBlock | null)[], missingIndexes: number[], missingBlockNumbers: number[] }> {
        if (!blockNumbers || blockNumbers.length === 0) {
            return { blocks: [], missingIndexes: [], missingBlockNumbers: [] };
        }

        const result: (StoredBlock | null)[] = new Array(blockNumbers.length).fill(null);
        const missingBlockNumbers: number[] = [];
        const missingIndexes: number[] = [];

        // Fetch all cached blocks with a single query
        const placeholders = blockNumbers.map(() => '?').join(',');
        const selectQuery = `SELECT block_number, data FROM blocks WHERE block_number IN (${placeholders})`;
        const rows = this.db.prepare(selectQuery).all(...blockNumbers) as { block_number: number; data: Buffer }[];

        // Create a map for quick lookup
        const cachedBlocksMap = new Map<number, Buffer>();
        for (const row of rows) {
            cachedBlocksMap.set(row.block_number, row.data);
        }

        // Process each requested block
        for (let i = 0; i < blockNumbers.length; i++) {
            const blockNumber = blockNumbers[i];
            const cachedData = cachedBlocksMap.get(blockNumber);

            if (cachedData) {
                // Decompress and parse the stored block
                const storedBlock = await decompress<StoredBlock>(cachedData);
                result[i] = storedBlock;
            } else {
                missingBlockNumbers.push(blockNumber);
                missingIndexes.push(i);
            }
        }

        return { blocks: result, missingIndexes, missingBlockNumbers };
    }

    public async storeBlocks(blocks: StoredBlock[]) {
        const insertQuery = `INSERT INTO blocks (block_number, data) VALUES (?, ?)`;
        const insertStatement = this.db.prepare(insertQuery);
        for (const block of blocks) {
            const compressedData = await compress(block);
            insertStatement.run(parseInt(block.block.number, 16), compressedData);
        }
    }

    public async getBlock(blockNumber: number): Promise<StoredBlock | null> {
        const blocks = await this.getBlocks([blockNumber]);
        return blocks.blocks[0] ?? null;
    }
}
