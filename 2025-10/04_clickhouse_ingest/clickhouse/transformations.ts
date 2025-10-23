import type { ArchivedBlock, CallTrace } from "../lib/types.ts";
import type { LogRow, BlockRow, TransactionRow, TraceRow } from "./client.ts";

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

function hexToDecimal(hex: string | undefined | null): string {
    if (!hex || hex === '0x' || hex === '0x0') return '0';
    // Remove 0x prefix if present
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    // Convert to BigInt then to string to handle large numbers
    return BigInt('0x' + cleanHex).toString();
}

export function transformBlockToLogs(block: ArchivedBlock): LogRow[] {
    const logs: LogRow[] = [];

    const blockTime = Number(block.block.timestamp);
    const blockNumber = Number(block.block.number);
    const blockHash = ensureHex(block.block.hash || '0x').toLowerCase();
    const blockDate = new Date(blockTime * 1000).toISOString().split('T')[0];

    for (const receipt of block.receipts) {
        const txHash = ensureHex(receipt.transactionHash).toLowerCase();
        const txIndex = Number(receipt.transactionIndex);

        // Find the corresponding transaction to get from/to
        const tx = block.block.transactions.find(t => typeof t !== 'string' && t.hash === receipt.transactionHash);
        const txFrom = (tx && typeof tx !== 'string') ? padAddress(tx.from) : '0x' + '0'.repeat(40);
        const txTo = (tx && typeof tx !== 'string' && tx.to) ? padAddress(tx.to) : '0x' + '0'.repeat(40);

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
        hash: ensureHex((block.block.hash || '0x') as string).toLowerCase(),
        parent_hash: ensureHex((block.block.parentHash || '0x') as string).toLowerCase(),
        miner: padAddress(block.block.miner || '0x'),
        nonce: ensureHex(block.block.nonce || '0x0000000000000000').toLowerCase(),
        date: blockDate,
    };
}

export function transformBlockToTransactions(block: ArchivedBlock): TransactionRow[] {
    const transactions: TransactionRow[] = [];
    const blockTime = Number(block.block.timestamp);
    const blockNumber = Number(block.block.number);
    const blockHash = ensureHex(block.block.hash || '0x').toLowerCase();
    const blockDate = new Date(blockTime * 1000).toISOString().split('T')[0];

    for (const tx of block.block.transactions) {
        // Data integrity check - must have full transaction objects, not just hashes
        if (typeof tx === 'string') {
            throw new Error(`Block ${blockNumber}: Transaction is a hash string, not a full transaction object`);
        }

        const txHash = ensureHex(tx.hash || '0x').toLowerCase();

        // Find the receipt to get success status and gas_used
        const receipt = block.receipts.find(r => r.transactionHash === tx.hash);
        if (!receipt) {
            throw new Error(`Block ${blockNumber}: No receipt found for transaction ${txHash}`);
        }

        const success = receipt.status === 'success' ? 1 : 0;
        const gasUsed = Number(receipt.gasUsed);

        // Parse access list if present
        const accessList: Array<[string, string[]]> = [];
        if (tx.accessList && Array.isArray(tx.accessList)) {
            for (const item of tx.accessList) {
                const address = padAddress(item.address);
                const storageKeys = item.storageKeys?.map(key => ensureHex(key as string).toLowerCase()) || [];
                accessList.push([address, storageKeys]);
            }
        }

        transactions.push({
            block_time: blockTime,
            block_number: blockNumber,
            value: hexToDecimal(tx.value?.toString()),
            gas_limit: Number(tx.gas),
            gas_price: Number(tx.gasPrice || 0),
            gas_used: gasUsed,
            max_fee_per_gas: tx.maxFeePerGas ? Number(tx.maxFeePerGas) : null,
            max_priority_fee_per_gas: tx.maxPriorityFeePerGas ? Number(tx.maxPriorityFeePerGas) : null,
            priority_fee_per_gas: receipt?.effectiveGasPrice ? Number(receipt.effectiveGasPrice) - Number(block.block.baseFeePerGas || 0) : null,
            nonce: Number(tx.nonce),
            index: Number(tx.transactionIndex),
            success: success,
            from: padAddress(tx.from),
            to: tx.to ? padAddress(tx.to) : null,
            block_hash: blockHash,
            data: ensureHex(tx.input).toLowerCase(),
            hash: txHash,
            type: Number(tx.type || 0),
            access_list: accessList,
            block_date: blockDate,
        });
    }

    return transactions;
}

function flattenTrace(
    trace: CallTrace,
    blockTime: number,
    blockNumber: number,
    blockHash: string,
    blockDate: string,
    txIndex: number,
    txHash: string,
    txSuccess: number,
    traceAddress: number[] = [],
    result: TraceRow[] = []
): TraceRow[] {
    // trace.gasUsed is TOTAL gas including all descendants
    // net_gas_used = total - sum of direct children's total gas
    const thisGasUsed = Number(trace.gasUsed || 0);
    const childrenGasUsed = trace.calls?.reduce((sum, child) => sum + Number(child.gasUsed || 0), 0) || 0;
    let netGasUsed = thisGasUsed - childrenGasUsed;

    // Handle buggy trace data where children sum > parent (shouldn't happen but does in rare cases)
    // This is likely due to gas refund accounting bugs in the RPC trace
    if (netGasUsed < 0) {
        // console.warn(
        //     `WARNING: Block ${blockNumber}, tx ${txHash}, trace [${traceAddress.join(',')}]: ` +
        //     `children gasUsed (${childrenGasUsed}) > parent gasUsed (${thisGasUsed}). ` +
        //     `Clamping net_gas_used to 0. This indicates buggy trace data from RPC.`
        // );
        netGasUsed = 0;
    }

    // Determine trace type and related fields
    const traceType = trace.type.toLowerCase();
    const isCall = traceType === 'call' || traceType === 'delegatecall' || traceType === 'staticcall' || traceType === 'callcode';
    const isCreate = traceType === 'create' || traceType === 'create2';

    result.push({
        block_time: blockTime,
        block_number: blockNumber,
        value: hexToDecimal(trace.value),
        gas: Number(trace.gas || 0),
        gas_used: thisGasUsed,
        net_gas_used: netGasUsed,
        block_hash: blockHash,
        success: 1, // Individual trace success (would need error field to determine)
        tx_index: txIndex,
        sub_traces: trace.calls?.length || 0,
        error: null, // TODO: extract from trace if available
        tx_success: txSuccess,
        tx_hash: txHash,
        from: padAddress(trace.from),
        to: trace.to ? padAddress(trace.to) : null,
        trace_address: traceAddress,
        type: traceType,
        address: isCreate ? padAddress(trace.to) : null,
        code: null, // TODO: extract init code for creates
        call_type: isCall ? traceType : null,
        input: ensureHex(trace.input || '0x').toLowerCase(),
        output: null, // TODO: extract output if available
        refund_address: null, // Only for suicide/selfdestruct traces
        block_date: blockDate,
    });

    // Recursively process child traces
    if (trace.calls && trace.calls.length > 0) {
        trace.calls.forEach((childTrace, index) => {
            flattenTrace(
                childTrace,
                blockTime,
                blockNumber,
                blockHash,
                blockDate,
                txIndex,
                txHash,
                txSuccess,
                [...traceAddress, index],
                result
            );
        });
    }

    return result;
}

export function transformBlockToTraces(block: ArchivedBlock): TraceRow[] {
    const traces: TraceRow[] = [];

    if (!block.traces || block.traces.length === 0) {
        return traces;
    }

    const blockTime = Number(block.block.timestamp);
    const blockNumber = Number(block.block.number);
    const blockHash = ensureHex((block.block.hash || '0x') as string).toLowerCase();
    const blockDate = new Date(blockTime * 1000).toISOString().split('T')[0];

    // Ensure receipts are ordered by transaction index
    const receipts = block.receipts.slice().sort((a, b) =>
        Number(a.transactionIndex) - Number(b.transactionIndex)
    );

    // Detect format: check if first item has txHash property
    const firstTrace = block.traces[0] as any;
    const isWrappedFormat = firstTrace && 'txHash' in firstTrace && 'result' in firstTrace;

    if (isWrappedFormat) {
        // Format 1: array of {txHash, result}
        // Traces should be ordered same as transactions/receipts
        if (block.traces.length !== block.block.transactions.length) {
            console.error(`Block ${blockNumber}: trace count (${block.traces.length}) !== transaction count (${block.block.transactions.length})`);
            process.exit(1);
        }

        for (let i = 0; i < block.traces.length; i++) {
            const traceResult = block.traces[i] as any;
            const tx = block.block.transactions[i];
            const receipt = receipts[i];

            if (typeof tx === 'string') {
                console.error(`Block ${blockNumber}: Transaction at index ${i} is a hash string, not a full object`);
                process.exit(1);
            }

            // Skip completely empty trace objects (edge case for ~6k txs)
            if (Object.keys(traceResult).length === 0) {
                continue;
            }

            if (!traceResult.txHash) {
                console.error(`Block ${blockNumber}: trace missing txHash at index ${i}: ${JSON.stringify(traceResult)}`);
                process.exit(1);
            }

            const txHash = ensureHex(tx.hash).toLowerCase();
            const traceHash = ensureHex(traceResult.txHash).toLowerCase();

            // Verify trace txHash matches transaction hash at same index
            if (txHash !== traceHash) {
                console.error(
                    `Block ${blockNumber}, index ${i}: txHash mismatch - ` +
                    `tx.hash: ${txHash}, trace.txHash: ${traceHash}. Arrays not aligned!`
                );
                process.exit(1);
            }

            // Verify receipt matches
            const receiptHash = ensureHex(receipt.transactionHash).toLowerCase();
            if (txHash !== receiptHash) {
                console.error(
                    `Block ${blockNumber}, index ${i}: receipt mismatch - ` +
                    `tx.hash: ${txHash}, receipt.hash: ${receiptHash}. Arrays not aligned!`
                );
                process.exit(1);
            }

            // Validate from/to addresses match between trace and transaction
            const traceFrom = padAddress(traceResult.result.from);
            const txFrom = padAddress(tx.from);

            if (traceFrom !== txFrom) {
                console.error(
                    `Block ${blockNumber}, tx ${txHash} at index ${i}: from address mismatch - ` +
                    `trace: ${traceFrom}, tx: ${txFrom}. Data corruption!`
                );
                console.error(`Full trace object:`, JSON.stringify(traceResult, null, 2));
                console.error(`Transaction data:`, JSON.stringify(tx, null, 2));
                console.error(`Receipt data:`, JSON.stringify(receipt, null, 2));
                process.exit(1);
            }

            // Only validate 'to' for non-contract-creation transactions
            if (traceResult.result.type.toLowerCase() === 'call' && tx.to) {
                const traceTo = padAddress(traceResult.result.to);
                const txTo = padAddress(tx.to);
                if (traceTo !== txTo) {
                    console.error(
                        `Block ${blockNumber}, tx ${txHash} at index ${i}: to address mismatch - ` +
                        `trace: ${traceTo}, tx: ${txTo}. Data corruption!`
                    );
                    process.exit(1);
                }
            }

            const txSuccess = receipt.status === 'success' ? 1 : 0;
            const txIndex = Number(receipt.transactionIndex);

            // Flatten the trace tree
            flattenTrace(
                traceResult.result,
                blockTime,
                blockNumber,
                blockHash,
                blockDate,
                txIndex,
                txHash,
                txSuccess,
                [],
                traces
            );
        }
    } else {
        // Format 2: array of CallTrace objects directly
        // Traces MUST be in the same order as transactions
        if (block.traces.length !== block.block.transactions.length) {
            console.error(
                `Block ${blockNumber}: trace count (${block.traces.length}) !== ` +
                `transaction count (${block.block.transactions.length}) for unwrapped traces`
            );
            process.exit(1);
        }

        for (let i = 0; i < block.traces.length; i++) {
            const trace = block.traces[i] as any; // It's actually a CallTrace
            const tx = block.block.transactions[i];
            const receipt = receipts[i];

            if (typeof tx === 'string') {
                console.error(`Block ${blockNumber}: Transaction at index ${i} is a hash string, not a full object`);
                process.exit(1);
            }

            // Skip completely empty trace objects (edge case for ~6k txs)
            if (Object.keys(trace).length === 0) {
                continue;
            }

            const txHash = ensureHex(tx.hash).toLowerCase();

            // Verify receipt matches
            const receiptHash = ensureHex(receipt.transactionHash).toLowerCase();
            if (txHash !== receiptHash) {
                console.error(
                    `Block ${blockNumber}, index ${i}: receipt mismatch - ` +
                    `tx.hash: ${txHash}, receipt.hash: ${receiptHash}. Arrays not aligned!`
                );
                process.exit(1);
            }

            // Validate from/to addresses match between trace and transaction
            const traceFrom = padAddress(trace.from);
            const txFrom = padAddress(tx.from);

            if (traceFrom !== txFrom) {
                console.error(
                    `Block ${blockNumber}, tx ${txHash} at index ${i}: from address mismatch - ` +
                    `trace: ${traceFrom}, tx: ${txFrom}. Data corruption!`
                );
                console.error(`Full trace object:`, JSON.stringify(trace, null, 2));
                console.error(`Transaction data:`, JSON.stringify(tx, null, 2));
                console.error(`Receipt data:`, JSON.stringify(receipt, null, 2));
                process.exit(1);
            }

            // Only validate 'to' for non-contract-creation transactions  
            if (trace.type.toLowerCase() === 'call' && tx.to) {
                const traceTo = padAddress(trace.to);
                const txTo = padAddress(tx.to);
                if (traceTo !== txTo) {
                    console.error(
                        `Block ${blockNumber}, tx ${txHash} at index ${i}: to address mismatch - ` +
                        `trace: ${traceTo}, tx: ${txTo}. Data corruption!`
                    );
                    process.exit(1);
                }
            }

            const txSuccess = receipt.status === 'success' ? 1 : 0;
            const txIndex = Number(receipt.transactionIndex);

            // Flatten the trace tree
            flattenTrace(
                trace,
                blockTime,
                blockNumber,
                blockHash,
                blockDate,
                txIndex,
                txHash,
                txSuccess,
                [],
                traces
            );
        }
    }

    return traces;
}

