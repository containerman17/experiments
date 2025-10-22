import type { Block, Transaction, TransactionReceipt } from "viem";

export interface CallTrace {
    from: string;
    gas: string;
    gasUsed: string;
    to: string;
    input: string;
    calls?: CallTrace[];
    value: string;
    type: string;
}

export interface TraceResult {
    txHash: string;
    result: CallTrace;
}

export interface IngestBlockParams {
    transactions: Transaction[];
    traces: TraceResult[];
    receipts: TransactionReceipt[];
}

export interface ArchivedBlock {
    block: Block;
    traces: TraceResult[] | CallTrace[] | undefined;
    receipts: TransactionReceipt[];
}

export type StoredBlocks = Record<number, IngestBlockParams>;

export type StoredRawBlock = {
    number: number;
    hash: string;
    parent_hash: string;
    time: number;
    miner: string;
    difficulty: string;
    total_difficulty: string;
    size: number;
    gas_limit: string;
    gas_used: string;
    base_fee_per_gas?: string;
    transactions_count: number;
    state_root: string;
    transactions_root: string;
    receipts_root: string;
    extra_data: string;
    logs_bloom: string;
    mix_hash: string;
    nonce: string;
    uncles_hash: string;
    blob_gas_used?: string;
    excess_blob_gas?: string;
}

export type StoredRawTransaction = {
    block_number: number;
    block_time: number;
    block_hash: string;
    transaction_index: number;
    hash: string;
    from: string;
    to?: string;
    value: string;
    gas: string;
    gas_price?: string;
    max_fee_per_gas?: string;
    max_priority_fee_per_gas?: string;
    priority_fee_per_gas?: string;
    nonce: number;
    input: string;
    tx_type: number;
    chain_id: number;
    signature_v: string;
    signature_r: string;
    signature_s: string;
    access_list?: string;
    max_fee_per_blob_gas?: string;
}

export type StoredEvent = {
    block_number: number;
    transaction_index: number;
    hash: string;
    topic0: string;
    topic1: string;
    topic2: string;
    topic3: string;
    data: string;
}

export type StoredFunctionCall = {
    block_number: number;
    transaction_index: number;
} & Omit<CallTrace, "calls">;
