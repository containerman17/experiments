export interface Log {
    address: string;
    topics: string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
    transactionIndex: string;
    blockHash: string;
    logIndex: string;
    removed: boolean;
}

export interface Receipt {
    blockHash: string;
    blockNumber: string;
    contractAddress: string | null;
    cumulativeGasUsed: string;
    effectiveGasPrice: string;
    from: string;
    gasUsed: string;
    logs: Log[];
    logsBloom: string;
    status: string;
    to: string;
    transactionHash: string;
    transactionIndex: string;
    type: string;
}

export interface Transaction {
    hash: string;
    blockHash: string;
    blockNumber: string;
    transactionIndex: string;
    from: string;
    to: string | null;
    value: string;
    gas: string;
    gasPrice: string;
    input: string;
    nonce: string;
    type: string;
    chainId: string;
    v: string;
    r: string;
    s: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    accessList?: string[];
    yParity?: string;
}

export interface Block {
    hash: string;
    number: string;
    parentHash: string;
    timestamp: string;
    gasLimit: string;
    gasUsed: string;
    baseFeePerGas: string;
    miner: string;
    difficulty: string;
    totalDifficulty: string;
    size: string;
    stateRoot: string;
    transactionsRoot: string;
    receiptsRoot: string;
    logsBloom: string;
    extraData: string;
    mixHash: string;
    nonce: string;
    sha3Uncles: string;
    uncles: string[];
    transactions: Transaction[];
    blobGasUsed?: string;
    excessBlobGas?: string;
    parentBeaconBlockRoot?: string;
    blockGasCost?: string;
}
