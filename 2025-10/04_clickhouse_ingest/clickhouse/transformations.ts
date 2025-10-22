import type { ArchivedBlock } from "../lib/types.ts";
import type { LogRow, BlockRow } from "./client.ts";

function ensureHex(hex: string): string {
    if (!hex.startsWith('0x')) {
        return '0x' + hex;
    }
    return hex;
}

function padTopic(topic: string | undefined): string {
    if (!topic) return '0x' + '0'.repeat(64);
    return ensureHex(topic).toLowerCase();
}

function padAddress(address: string | undefined | null): string {
    if (!address) return '0x' + '0'.repeat(40);
    return ensureHex(address).toLowerCase();
}

export function transformBlockToLogs(block: ArchivedBlock): LogRow[] {
    const logs: LogRow[] = [];

    const blockTime = Number(block.block.timestamp);
    const blockNumber = Number(block.block.number);
    const blockHash = ensureHex(block.block.hash).toLowerCase();
    const blockDate = new Date(blockTime * 1000).toISOString().split('T')[0];

    for (const receipt of block.receipts) {
        const txHash = ensureHex(receipt.transactionHash).toLowerCase();
        const txIndex = Number(receipt.transactionIndex);

        // Find the corresponding transaction to get from/to
        const tx = block.block.transactions.find(t => t.hash === receipt.transactionHash);
        const txFrom = tx ? padAddress(tx.from) : '0x' + '0'.repeat(40);
        const txTo = tx?.to ? padAddress(tx.to) : '0x' + '0'.repeat(40);

        for (const log of receipt.logs) {
            logs.push({
                block_time: blockTime,
                block_number: blockNumber,
                block_hash: blockHash,
                contract_address: padAddress(log.address),
                topic0: padTopic(log.topics[0]),
                topic1: padTopic(log.topics[1]),
                topic2: padTopic(log.topics[2]),
                topic3: padTopic(log.topics[3]),
                data: ensureHex(log.data).toLowerCase(),
                tx_hash: txHash,
                log_index: Number(log.logIndex),
                tx_index: txIndex,
                block_date: blockDate,
                tx_from: txFrom,
                tx_to: txTo,
            });
        }
    }

    return logs;
}

export function transformBlockToBlockRow(block: ArchivedBlock): BlockRow {
    const blockTime = Number(block.block.timestamp);
    const blockDate = new Date(blockTime * 1000).toISOString().split('T')[0];

    return {
        time: blockTime,
        timestamp: blockTime,
        number: Number(block.block.number),
        gas_limit: Number(block.block.gasLimit),
        gas_used: Number(block.block.gasUsed),
        difficulty: Number(block.block.difficulty || 0),
        total_difficulty: Number(block.block.totalDifficulty || 0),
        size: Number(block.block.size),
        base_fee_per_gas: block.block.baseFeePerGas ? Number(block.block.baseFeePerGas) : null,
        hash: ensureHex(block.block.hash).toLowerCase(),
        parent_hash: ensureHex(block.block.parentHash).toLowerCase(),
        miner: padAddress(block.block.miner),
        nonce: ensureHex(block.block.nonce || '0x0000000000000000').toLowerCase(),
        date: blockDate,
    };
}

