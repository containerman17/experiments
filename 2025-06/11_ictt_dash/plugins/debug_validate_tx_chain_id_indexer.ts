import type { IndexingPlugin } from "frostbyte-sdk";

const cachedHexToNumber = new Map<string, number>();
function hexToNumberCached(hex: string): number {
    if (cachedHexToNumber.has(hex)) {
        return cachedHexToNumber.get(hex)!;
    }
    const number = parseInt(hex, 16);
    cachedHexToNumber.set(hex, number);
    return number;
}

const module: IndexingPlugin = {
    name: "debug_validate_tx_chain_id",
    version: 2,
    usesTraces: false,

    // Initialize tables
    initialize: (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS debug_chain_ids (
                batch_start_ts INTEGER NOT NULL,
                batch_end_ts INTEGER NOT NULL,
                chain_id INTEGER NOT NULL,
                tx_count INTEGER NOT NULL
            )
        `);
    },

    // Process transactions
    handleTxBatch: (db, blocksDb, batch) => {
        const chainIdStats = new Map<number, number>();

        for (const tx of batch.txs) {
            const chainId = hexToNumberCached(tx.tx.chainId);
            chainIdStats.set(chainId, (chainIdStats.get(chainId) || 0) + 1);
        }

        for (const [chainId, txCount] of chainIdStats.entries()) {
            db.prepare(`
                INSERT INTO debug_chain_ids (batch_start_ts, batch_end_ts, chain_id, tx_count) 
                VALUES (?, ?, ?, ?)
            `).run(batch.txs[0].blockTs, batch.txs[batch.txs.length - 1].blockTs, chainId || 0, txCount);
        }
    }
};

export default module;
