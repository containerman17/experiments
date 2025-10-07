import fs from 'fs/promises';
import path from 'path';
import * as zstd from 'zstd-napi';

const DATA_DIR = './data';

async function decodeAndCountFile(filePath) {
    const startTime = Date.now();
    
    // Read and decompress file
    const compressed = await fs.readFile(filePath);
    const decompressed = await zstd.decompress(compressed);
    const data = JSON.parse(decompressed.toString());
    
    // Count blocks, txs, traces, receipts
    let blockCount = 0;
    let txCount = 0;
    let traceCount = 0;
    let receiptCount = 0;
    
    for (const blockNumber in data) {
        blockCount++;
        
        const blockData = data[blockNumber];
        
        // Count transactions
        if (blockData.block && blockData.block.transactions) {
            txCount += blockData.block.transactions.length;
        }
        
        // Count receipts
        if (blockData.txReceipts) {
            receiptCount += Object.keys(blockData.txReceipts).length;
        }
        
        // Count traces
        if (blockData.traces) {
            traceCount += blockData.traces.length;
        }
    }
    
    const decodeTime = Date.now() - startTime;
    
    return {
        blocks: blockCount,
        txs: txCount,
        traces: traceCount,
        receipts: receiptCount,
        decodeTime
    };
}

async function main() {
    console.log('='.repeat(70));
    console.log('Block Data Decoder - Statistics');
    console.log('='.repeat(70));
    console.log(`Data directory: ${DATA_DIR}\n`);
    
    const overallStartTime = Date.now();
    
    // Read all .json.zstd files
    const files = await fs.readdir(DATA_DIR);
    const zstdFiles = files.filter(f => f.endsWith('.json.zstd')).sort();
    
    if (zstdFiles.length === 0) {
        console.log('No .json.zstd files found in data directory');
        return;
    }
    
    console.log(`Found ${zstdFiles.length} compressed files\n`);
    
    let totalBlocks = 0;
    let totalTxs = 0;
    let totalTraces = 0;
    let totalReceipts = 0;
    let totalDecodeTime = 0;
    
    for (const file of zstdFiles) {
        const filePath = path.join(DATA_DIR, file);
        
        try {
            const stats = await decodeAndCountFile(filePath);
            
            totalBlocks += stats.blocks;
            totalTxs += stats.txs;
            totalTraces += stats.traces;
            totalReceipts += stats.receipts;
            totalDecodeTime += stats.decodeTime;
            
            console.log(`${file}:`);
            console.log(`  Blocks: ${stats.blocks} | Txs: ${stats.txs} | Receipts: ${stats.receipts} | Traces: ${stats.traces} | Decode: ${stats.decodeTime}ms`);
        } catch (error) {
            console.error(`Error processing ${file}:`, error.message);
        }
    }
    
    const totalTime = Date.now() - overallStartTime;
    
    console.log('\n' + '='.repeat(70));
    console.log('TOTALS:');
    console.log('='.repeat(70));
    console.log(`Files processed:    ${zstdFiles.length}`);
    console.log(`Total blocks:       ${totalBlocks.toLocaleString()}`);
    console.log(`Total txs:          ${totalTxs.toLocaleString()}`);
    console.log(`Total receipts:     ${totalReceipts.toLocaleString()}`);
    console.log(`Total traces:       ${totalTraces.toLocaleString()}`);
    console.log(`Total decode time:  ${totalDecodeTime}ms (${(totalDecodeTime / 1000).toFixed(2)}s)`);
    console.log(`Overall time:       ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
    console.log(`Avg per file:       ${(totalDecodeTime / zstdFiles.length).toFixed(1)}ms`);
    console.log('='.repeat(70));
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

