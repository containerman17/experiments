import { type ChainConfig } from "frostbyte-sdk";

//@ts-ignore don't want to install @types/node just for this
import fs from "fs";

type ChainFromJson = {
    chainName: string;
    blockchainId: string;
    subnetId: string;
    rpcUrl: string;
    evmChainId: number;
    blocksCount: number;
    estimatedTxCount: number;
    comment: string;
    debugEnabled: boolean;
}

let chains: ChainFromJson[] = JSON.parse(fs.readFileSync("../01_rpc_list/data/chains.json", "utf8"));

if (fs.existsSync("./secretChains.json")) {
    const secretChains: ChainFromJson[] = JSON.parse(fs.readFileSync("./secretChains.json", "utf8"));

    for (const chain of secretChains) {
        const chainExists = chains.find(c => c.blockchainId === chain.blockchainId);
        if (chainExists) {
            chains = chains.filter(c => c.blockchainId !== chain.blockchainId);
        }
        chains.push(chain);
    }
}
const result: ChainConfig[] = [];

// Get optional max chains limit from command line argument
const debugFilterChainIds = process.argv[2] ? process.argv[2].split(',') : undefined;

const FORCE_DISABLE_DEBUG = true

const ENABLE_BATCH_SIZE_GROWTH = [
    "subnets.avax.network",
    "api.avax.network"
]


const DEFAULT_BLOCKS_PER_BATCH = 20

// Process chains and create configs with hardcoded values
for (const chain of chains) {
    if (!chain.evmChainId || !chain.rpcUrl) {
        continue;
    }

    // Determine final RPC URL - skip URL replacements for secret chains
    const host = new URL(chain.rpcUrl).hostname;

    const enableBatchSizeGrowth = ENABLE_BATCH_SIZE_GROWTH.includes(host);

    result.push({
        "chainName": chain.chainName,
        "blockchainId": chain.blockchainId,
        "evmChainId": Number(chain.evmChainId),
        "rpcConfig": {
            "rpcUrl": chain.rpcUrl,
            "requestBatchSize": 10,
            "rpcSupportsDebug": chain.debugEnabled && !FORCE_DISABLE_DEBUG,
            "enableBatchSizeGrowth": enableBatchSizeGrowth,
            "blocksPerBatch": DEFAULT_BLOCKS_PER_BATCH
        }
    });
}
// Limit the number of chains if maxChains is specified
const finalResult = debugFilterChainIds ? result.filter(chain => debugFilterChainIds.includes(chain.blockchainId)) : result;

fs.writeFileSync("./prod_chains.json", JSON.stringify(finalResult, null, 2));
console.log(`Saved ${finalResult.length} chains in prod_chains.json${debugFilterChainIds ? ` (limited to ${debugFilterChainIds})` : ''}`);
