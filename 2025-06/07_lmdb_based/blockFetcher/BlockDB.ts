import { open } from 'lmdb';
import { Block, Transaction } from './evmTypes';
import { StoredBlock } from './BatchRpc';

const MAX_UINT32 = 4294967295;
const MAX_UINT16 = 65535;

export class BlockDB {
    private db: any;

    constructor(path: string) {
        this.db = open({
            path: path,
            encoding: 'binary', // We'll handle our own encoding/decoding
            compression: true, // Enable compression for better storage efficiency
            pageSize: 8192,
        });
    }

    async storeBlocks(blocks: StoredBlock[]) {
        await this.db.transaction(() => {
            for (const block of blocks) {
                this.storeBlock(block);
            }
        });
    }

    private storeBlock(block: StoredBlock) {
        const blockNumber = Number(block.block.number);
        if (blockNumber > MAX_UINT32) {
            throw new Error("Block number too large");
        }

        const blockKey = getBlockKey(blockNumber);
        const blockData = encodeBlock(block.block);
        this.db.put(blockKey, blockData);

        for (let i = 0; i < block.block.transactions.length; i++) {
            const txKey = getTxKey(blockNumber, i);
            const txData = encodeTx(block.block.transactions[i]);
            this.db.put(txKey, txData);
        }
    }

    getBlock(blockNumber: number): Block {
        if (blockNumber > MAX_UINT32) {
            throw new Error("Block number too large");
        }

        const blockKey = getBlockKey(blockNumber);
        const blockData = this.db.get(blockKey);
        if (!blockData) {
            throw new Error(`Block ${blockNumber} not found`);
        }
        return decodeBlock(blockData);
    }

    getTx(blockNumber: number, txIndex: number): Transaction {
        if (blockNumber > MAX_UINT32) {
            throw new Error("Block number too large");
        }
        if (txIndex > MAX_UINT16) {
            throw new Error("Transaction index too large");
        }

        const txKey = getTxKey(blockNumber, txIndex);
        const txData = this.db.get(txKey);
        if (!txData) {
            throw new Error(`Transaction ${blockNumber}:${txIndex} not found`);
        }
        return decodeTx(txData);
    }

    close() {
        this.db.close();
    }
}

function getBlockKey(blockNumber: number): Buffer {
    if (blockNumber > MAX_UINT32) {
        throw new Error("Block number too large");
    }
    const buffer = new ArrayBuffer(5);
    const view = new DataView(buffer);
    view.setUint8(0, 0); // 0 prefix for blocks
    view.setUint32(1, blockNumber, false); // false for big-endian
    return Buffer.from(buffer);
}

function getTxKey(blockNumber: number, txIndex: number): Buffer {
    if (blockNumber > MAX_UINT32) {
        throw new Error("Block number too large");
    }
    if (txIndex > MAX_UINT16) {
        throw new Error("Transaction index too large");
    }
    const buffer = new ArrayBuffer(7);
    const view = new DataView(buffer);
    view.setUint8(0, 1); // 1 prefix for transactions  
    view.setUint32(1, blockNumber, false); // false for big-endian
    view.setUint16(5, txIndex, false); // false for big-endian
    return Buffer.from(buffer);
}

function encodeBlock(block: Block): Buffer {
    throw new Error("Not implemented");
}

function encodeTx(tx: Transaction): Buffer {
    throw new Error("Not implemented");
}

function decodeBlock(block: Buffer): Block {
    throw new Error("Not implemented");
}

function decodeTx(tx: Buffer): Transaction {
    throw new Error("Not implemented");
}
