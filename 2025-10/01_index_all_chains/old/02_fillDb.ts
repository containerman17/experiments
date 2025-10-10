import type { IDB, StoredBlocks, IngestBlockParams, StoredRawBlock, StoredRawTransaction, StoredEvent, StoredFunctionCall, CallTrace } from '../types.ts';
import { ClickHouseDB } from './clickhouse.ts';
import fs from 'fs/promises';
import path from 'path';
import * as zstd from 'zstd-napi';
import type { Transaction, TransactionReceipt } from 'viem';

const DATA_DIR = './data';
const CLICKHOUSE_HOST = 'http://localhost:8123';
const CLICKHOUSE_DATABASE = 'default';

async function dropTablesIfExist(db: ClickHouseDB) {
    try {
        await (db as any).client.exec({ query: 'DROP TABLE IF EXISTS raw_blocks' });
        await (db as any).client.exec({ query: 'DROP TABLE IF EXISTS raw_transactions' });
        await (db as any).client.exec({ query: 'DROP TABLE IF EXISTS events' });
        await (db as any).client.exec({ query: 'DROP TABLE IF EXISTS function_calls' });
        console.log('Dropped existing tables');
    } catch (error) {
        console.log('No existing tables to drop');
    }
}

function convertBlockToStoredRawBlock(block: any, transactions: Transaction[]): StoredRawBlock {
    return {
        number: Number(block.number),
        hash: block.hash,
        parent_hash: block.parentHash,
        time: Number(block.timestamp),
        miner: block.miner,
        difficulty: block.difficulty.toString(),
        total_difficulty: block.totalDifficulty?.toString() || '0',
        size: Number(block.size),
        gas_limit: block.gasLimit.toString(),
        gas_used: block.gasUsed.toString(),
        base_fee_per_gas: block.baseFeePerGas?.toString(),
        transactions_count: transactions.length,
        state_root: block.stateRoot,
        transactions_root: block.transactionsRoot,
        receipts_root: block.receiptsRoot,
        extra_data: block.extraData,
        logs_bloom: block.logsBloom,
        mix_hash: block.mixHash,
        nonce: block.nonce || '0x0',
        uncles_hash: block.sha3Uncles,
        blob_gas_used: block.blobGasUsed?.toString(),
        excess_blob_gas: block.excessBlobGas?.toString(),
    };
}

function convertTransactionToStoredRawTransaction(tx: Transaction, blockTime: number): StoredRawTransaction {
    // Convert type string to number
    let txType = 0;
    const txAny = tx as any;
    if (txAny.typeHex) {
        txType = parseInt(txAny.typeHex, 16);
    } else if (tx.type === 'legacy') {
        txType = 0;
    } else if (tx.type === 'eip2930') {
        txType = 1;
    } else if (tx.type === 'eip1559') {
        txType = 2;
    } else if (tx.type === 'eip4844') {
        txType = 3;
    }

    return {
        block_number: Number(tx.blockNumber),
        block_time: blockTime,
        block_hash: tx.blockHash!,
        transaction_index: tx.transactionIndex!,
        hash: tx.hash,
        from: tx.from,
        to: tx.to || undefined,
        value: tx.value.toString(),
        gas: tx.gas.toString(),
        gas_price: tx.gasPrice?.toString(),
        max_fee_per_gas: tx.maxFeePerGas?.toString(),
        max_priority_fee_per_gas: tx.maxPriorityFeePerGas?.toString(),
        priority_fee_per_gas: txAny.priorityFeePerGas?.toString(),
        nonce: tx.nonce,
        input: tx.input,
        tx_type: txType,
        chain_id: tx.chainId !== undefined ? Number(tx.chainId) : 0,
        signature_v: tx.v.toString(),
        signature_r: tx.r,
        signature_s: tx.s,
        access_list: tx.accessList ? JSON.stringify(tx.accessList) : undefined,
        max_fee_per_blob_gas: txAny.maxFeePerBlobGas?.toString(),
    };
}

function extractEventsFromReceipt(receipt: TransactionReceipt, blockNumber: number, txIndex: number): StoredEvent[] {
    return receipt.logs.map(log => ({
        block_number: blockNumber,
        transaction_index: txIndex,
        hash: receipt.transactionHash,
        topic0: log.topics[0] || '',
        topic1: log.topics[1] || '',
        topic2: log.topics[2] || '',
        topic3: log.topics[3] || '',
        data: log.data,
    }));
}

function flattenCallTrace(trace: CallTrace, blockNumber: number, txIndex: number): StoredFunctionCall[] {
    const calls: StoredFunctionCall[] = [];

    function recurse(call: CallTrace) {
        calls.push({
            block_number: blockNumber,
            transaction_index: txIndex,
            from: call.from,
            gas: call.gas,
            gasUsed: call.gasUsed,
            to: call.to,
            input: call.input,
            value: call.value || "",
            type: call.type,
        });

        if (call.calls) {
            for (const subcall of call.calls) {
                recurse(subcall);
            }
        }
    }

    recurse(trace);
    return calls;
}

async function processFile(db: ClickHouseDB, filePath: string): Promise<{ blocks: number, txs: number }> {
    console.log(`Processing ${path.basename(filePath)}...`);

    // Read and decompress file
    const compressed = await fs.readFile(filePath);
    const decompressed = await zstd.decompress(compressed);
    const data: StoredBlocks = JSON.parse(decompressed.toString());

    let blockCount = 0;
    let txCount = 0;

    // Start transaction for entire file
    db.beginTransaction();

    try {
        // Process each block in the file
        for (const [blockNumberStr, blockData] of Object.entries(data)) {
            console.log(`Processing block ${blockNumberStr}...`);
            const blockNumber = parseInt(blockNumberStr);
            const { transactions, traces, receipts } = blockData;

            if (transactions.length === 0) continue;

            // Get block metadata from first transaction
            const firstTx = transactions[0];
            const block = {
                number: firstTx.blockNumber,
                hash: firstTx.blockHash,
                parentHash: (firstTx as any).parentHash || '0x0',
                timestamp: BigInt(0), // Will be set from receipt if available
                miner: '0x0000000000000000000000000000000000000000',
                difficulty: BigInt(0),
                totalDifficulty: BigInt(0),
                size: BigInt(0),
                gasLimit: BigInt(0),
                gasUsed: BigInt(0),
                baseFeePerGas: (firstTx as any).baseFeePerGas,
                stateRoot: '0x0',
                transactionsRoot: '0x0',
                receiptsRoot: '0x0',
                extraData: '0x',
                logsBloom: '0x',
                mixHash: '0x0',
                nonce: '0x0',
                sha3Uncles: '0x0',
            };

            // Try to get timestamp from receipts
            const blockTime = receipts.length > 0 ? Number((receipts[0] as any).blockTimestamp || 0) : 0;

            // Store block
            const storedBlock = convertBlockToStoredRawBlock(block, transactions);
            storedBlock.time = blockTime;
            await db.storeRawBlock(storedBlock);
            blockCount++;

            // Store transactions, events, and function calls
            for (let i = 0; i < transactions.length; i++) {
                const tx = transactions[i];
                const receipt = receipts.find(r => r.transactionHash === tx.hash);

                // Store transaction
                const storedTx = convertTransactionToStoredRawTransaction(tx, blockTime);
                await db.storeRawTransaction(storedTx);
                txCount++;

                // Store events from receipt
                if (receipt) {
                    const events = extractEventsFromReceipt(receipt, blockNumber, tx.transactionIndex!);
                    for (const event of events) {
                        await db.storeEvent(event);
                    }
                }

                // Store function calls from traces
                const trace = traces.find(t => t.txHash === tx.hash);
                if (trace && trace.result) {
                    const functionCalls = flattenCallTrace(trace.result, blockNumber, tx.transactionIndex!);
                    for (const call of functionCalls) {
                        await db.storeFunctionCall(call);
                    }
                }
            }
        }

        // Commit transaction
        await db.commit();

        return { blocks: blockCount, txs: txCount };
    } catch (error) {
        db.rollback();
        throw error;
    }
}

async function getDbSize(db: ClickHouseDB): Promise<number> {
    try {
        const result = await (db as any).client.query({
            query: `
                SELECT sum(bytes_on_disk) as total_bytes
                FROM system.parts
                WHERE database = '${CLICKHOUSE_DATABASE}'
                AND active = 1
            `
        });
        const data = await result.json();
        return data.data[0]?.total_bytes ? Number(data.data[0].total_bytes) : 0;
    } catch {
        return 0;
    }
}

async function main() {
    console.log('='.repeat(60));
    console.log('Database Filler');
    console.log('='.repeat(60));

    // Initialize database
    const db = await ClickHouseDB.create(CLICKHOUSE_HOST, CLICKHOUSE_DATABASE);

    // Drop existing tables
    await dropTablesIfExist(db);

    // Initialize fresh tables
    await db.initialize();
    console.log('Database initialized');
    console.log('Using ClickHouse with batch inserts for optimal performance\n');

    // Get all data files
    const files = (await fs.readdir(DATA_DIR)).slice(0, 4)
    const dataFiles = files
        .filter(f => f.endsWith('.json.zstd'))
        .sort()
        .map(f => path.join(DATA_DIR, f));

    console.log(`Found ${dataFiles.length} data files\n`);

    let totalBlocks = 0;
    let totalTxs = 0;
    const startTime = Date.now();

    // Process each file
    for (let i = 0; i < dataFiles.length; i++) {
        const file = dataFiles[i];
        const fileStartTime = Date.now();

        const { blocks, txs } = await processFile(db, file);
        totalBlocks += blocks;
        totalTxs += txs;

        const fileTime = (Date.now() - fileStartTime) / 1000;
        const totalTime = (Date.now() - startTime) / 1000;
        const avgSpeed = (totalTxs / totalTime).toFixed(2);

        console.log(`  ✓ Processed ${blocks} blocks, ${txs} txs in ${fileTime.toFixed(1)}s (${i + 1}/${dataFiles.length})`);
        console.log(`    Total: ${totalBlocks} blocks, ${totalTxs} txs | Avg: ${avgSpeed} txs/s\n`);
    }

    // Optimize tables
    console.log('\nOptimizing tables...');
    const optimizeStart = Date.now();
    await (db as any).client.exec({ query: 'OPTIMIZE TABLE raw_blocks FINAL' });
    await (db as any).client.exec({ query: 'OPTIMIZE TABLE raw_transactions FINAL' });
    await (db as any).client.exec({ query: 'OPTIMIZE TABLE events FINAL' });
    await (db as any).client.exec({ query: 'OPTIMIZE TABLE function_calls FINAL' });
    const optimizeTime = (Date.now() - optimizeStart) / 1000;
    console.log(`Optimization completed in ${optimizeTime.toFixed(1)}s`);

    // Get table row counts
    const counts = await db.getTableCounts();

    // Calculate and display storage stats
    const dbSize = await getDbSize(db);

    // Close database connection
    await db.close();
    const storagePerTx = totalTxs > 0 ? (dbSize / totalTxs) : 0;

    console.log('='.repeat(60));
    console.log('Final Statistics');
    console.log('='.repeat(60));
    console.log(`Total blocks: ${totalBlocks}`);
    console.log(`Total transactions: ${totalTxs}`);
    console.log('');
    console.log('Table Row Counts:');
    console.log(`  Blocks:         ${counts.blocks.toLocaleString()}`);
    console.log(`  Transactions:   ${counts.transactions.toLocaleString()}`);
    console.log(`  Events:         ${counts.events.toLocaleString()}`);
    console.log(`  Function Calls: ${counts.functionCalls.toLocaleString()}`);
    console.log('');
    console.log(`Database size: ${(dbSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Storage per transaction: ${storagePerTx.toFixed(2)} bytes`);
    console.log('='.repeat(60));
}

main().catch(console.error);