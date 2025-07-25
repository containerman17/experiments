import { ChainConfig } from "frostbyte-sdk";

//@ts-ignore don't want to install @types/node just for this
import fs from "fs";

// TODO: Remember to handle excluded chains - currently excluding Avalanche C-Chain (43114)
const EXCLUDED_CHAIN_IDS = {
    // 43114: "Avalanche C-Chain" // Exclude this chain from processing
};

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
const secretChainIds = new Set<string>();

if (fs.existsSync("./secretChains.json")) {
    const secretChains: ChainFromJson[] = JSON.parse(fs.readFileSync("./secretChains.json", "utf8"));

    // Track which chains are from secret file
    secretChains.forEach(chain => {
        if (chain.blockchainId) {
            secretChainIds.add(chain.blockchainId);
        }
    });

    // Create a map to avoid duplicates, secretChains have priority
    const chainsMap = new Map<string, ChainFromJson>();

    // First add main chains
    chains.forEach(chain => {
        if (chain.blockchainId) {
            chainsMap.set(chain.blockchainId, chain);
        }
    });

    // Then add secret chains (will override any existing with same blockchainId)
    secretChains.forEach(chain => {
        if (chain.blockchainId) {
            chainsMap.set(chain.blockchainId, chain);
        }
    });

    chains = Array.from(chainsMap.values());
}
const result: ChainConfig[] = [];

// Get optional max chains limit from command line argument
const debugFilterChainIds = process.argv[2] ? process.argv[2].split(',') : undefined;

const USE_IDX3_INSTEAD = true;//TODO: remove after initial sync is done
const FORCE_DISABLE_DEBUG = true

const RPS_PER_HOST = {
    "meganode.solokhin.com": 20000,
    "65.21.140.118": 20000,  // meganode IP should have same RPS
    "idx3.solokhin.com": 100000,
    "65.108.99.35": 100000,   // idx3 IP should have same RPS
    "idx2.solokhin.com": 50000,  // idx2 has good performance
    "subnets.avax.network": 20,
    "api.avax.network": 20,
    "default": 20,
}

const DISABLE_BLOCK_GROWTH = [
    "meganode.solokhin.com",
    "65.21.140.118",  // meganode IP should also disable block growth
    "65.108.99.35",
    "idx3.solokhin.com",
    "idx2.solokhin.com",
]

const MAX_CONCURRENCY_PER_HOST = {
    "idx3.solokhin.com": 1500,
    "65.108.99.35": 1500,  // idx3 IP should have same high concurrency
    "idx2.solokhin.com": 800,  // idx2 has good concurrency
    "meganode.solokhin.com": 300,
    "65.21.140.118": 300,  // meganode IP should have same concurrency  
    "subnets.avax.network": 100,
    "api.avax.network": 100,
    "rpc.step.network": 100,
    "rpc.amichain.org": 100,
    "rpc-codenekt-mainnet.cogitus.io": 100,
    "default": 100,
}

const REQUEST_BATCH_SIZE_PER_HOST = {
    "idx3.solokhin.com": 100,
    "65.108.99.35": 100,   // idx3 IP should have same batch size
    "idx2.solokhin.com": 50,   // idx2 has good batch size
    "default": 10,
}

const URL_REPLACEMENTS = {
    "https://meganode.solokhin.com/": "http://65.21.140.118/",
    "https://idx3.solokhin.com/": "http://65.108.99.35/"
}

const DEFAULT_REQUEST_BATCH_SIZE = 10
const DEFAULT_BLOCKS_PER_BATCH = 3000


async function checkIdx3Deployments(chains) {
    if (!USE_IDX3_INSTEAD) return {};
    const results = await Promise.allSettled(
        chains.map(async (chain) => {
            if (!chain.evmChainId) return [chain.evmChainId, false];
            const idx3Url = `http://65.108.99.35/api/${chain.evmChainId}/rpc`;
            try {
                const res = await fetch(idx3Url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })
                });
                if (!res.ok) return [chain.evmChainId, false];
                const data = await res.json();
                if (data.error) return [chain.evmChainId, false];
                // eth_chainId returns hex string
                const returnedId = parseInt(data.result, 16);
                if (returnedId === Number(chain.evmChainId)) {
                    return [chain.evmChainId, idx3Url];
                }
            } catch (e) {
                // ignore
            } finally {
                console.log(`Checked ${chain.chainName} on idx3`);
            }
            return [chain.evmChainId, false];
        })
    );
    // Map of evmChainId -> idx3Url or false
    return Object.fromEntries(results.map(r => r.status === 'fulfilled' ? r.value : [null, false]));
}

async function checkIdx2Deployments(chains) {
    const results = await Promise.allSettled(
        chains.map(async (chain) => {
            if (!chain.blockchainId) return [chain.blockchainId, false];
            const idx2Url = `https://${chain.blockchainId}.idx2.solokhin.com/api/rpc`;
            try {
                const res = await fetch(idx2Url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })
                });
                if (!res.ok) return [chain.blockchainId, false];
                const data = await res.json();
                if (data.error) return [chain.blockchainId, false];
                // eth_chainId returns hex string
                const returnedId = parseInt(data.result, 16);
                if (returnedId === Number(chain.evmChainId)) {
                    return [chain.blockchainId, idx2Url];
                }
            } catch (e) {
                // ignore
            } finally {
                console.log(`Checked ${chain.chainName} on idx2`);
            }
            return [chain.blockchainId, false];
        })
    );
    // Map of blockchainId -> idx2Url or false
    return Object.fromEntries(results.map(r => r.status === 'fulfilled' ? r.value : [null, false]));
}

// Check idx3 and idx2 deployments in parallel
const idx3Map = await checkIdx3Deployments(chains);
const idx2Map = await checkIdx2Deployments(chains);

// First pass: determine final URLs and count chains per final host
const hostCounts: { [host: string]: number } = {};
const chainWithFinalUrls: Array<{ chain: ChainFromJson, finalRpcUrl: string, finalHost: string }> = [];

for (const chain of chains) {
    if (!chain.evmChainId || !chain.rpcUrl) {
        continue;
    }

    // Skip excluded chains
    if (EXCLUDED_CHAIN_IDS[chain.evmChainId]) {
        console.log(`Skipping excluded chain: ${chain.chainName} (evmChainId: ${chain.evmChainId})`);
        continue;
    }

    // Determine final RPC URL - skip URL replacements for secret chains
    let finalRpcUrl = chain.rpcUrl;

    // Secret chains should use their original URLs without any replacements
    if (!secretChainIds.has(chain.blockchainId)) {
        // Priority order: idx3 -> idx2 -> original with URL_REPLACEMENTS
        if (USE_IDX3_INSTEAD && idx3Map[chain.evmChainId]) {
            finalRpcUrl = idx3Map[chain.evmChainId];
        } else if (idx2Map[chain.blockchainId]) {
            finalRpcUrl = idx2Map[chain.blockchainId];
        } else {
            for (const [from, to] of Object.entries(URL_REPLACEMENTS)) {
                finalRpcUrl = finalRpcUrl.replace(from, to);
            }
        }
    }

    const finalUrl = new URL(finalRpcUrl);
    let finalHost = finalUrl.hostname;

    // Handle idx2 subdomains - treat them as idx2.solokhin.com for configuration
    if (finalHost.endsWith('.idx2.solokhin.com')) {
        finalHost = 'idx2.solokhin.com';
    }

    // Count based on final host
    hostCounts[finalHost] = (hostCounts[finalHost] || 0) + 1;

    chainWithFinalUrls.push({ chain, finalRpcUrl, finalHost });
}

// Second pass: create chain configs with calculated RPS and maxConcurrentRequests based on final hosts
for (const { chain, finalRpcUrl, finalHost } of chainWithFinalUrls) {
    const enableBatchSizeGrowth = !DISABLE_BLOCK_GROWTH.includes(finalHost);

    const hostRps = RPS_PER_HOST[finalHost] || RPS_PER_HOST["default"];
    const hostMaxConcurrency = MAX_CONCURRENCY_PER_HOST[finalHost] || MAX_CONCURRENCY_PER_HOST["default"];
    const hostRequestBatchSize = REQUEST_BATCH_SIZE_PER_HOST[finalHost] || REQUEST_BATCH_SIZE_PER_HOST["default"];
    const chainCount = hostCounts[finalHost];
    const rpsPerChain = Math.ceil(hostRps / chainCount);
    const maxConcurrentRequestsPerChain = Math.ceil(hostMaxConcurrency / chainCount);

    //TODO: remove
    // if (chain.rpcUrl.includes("subnets.avax.network")) {
    //     console.log(`WARNING: ${chain.chainName} is using subnets.avax.network, due to temporary issues, disabled`);
    //     continue;
    // }

    result.push({
        "chainName": chain.chainName,
        "blockchainId": chain.blockchainId,
        "evmChainId": Number(chain.evmChainId),
        "rpcConfig": {
            "rpcUrl": finalRpcUrl,
            "requestBatchSize": hostRequestBatchSize,
            "maxConcurrentRequests": maxConcurrentRequestsPerChain,
            "rps": rpsPerChain,
            "rpcSupportsDebug": chain.debugEnabled && !FORCE_DISABLE_DEBUG,
            "enableBatchSizeGrowth": enableBatchSizeGrowth,
            "blocksPerBatch": DEFAULT_BLOCKS_PER_BATCH
        },

    },);
}
// Limit the number of chains if maxChains is specified
const finalResult = debugFilterChainIds ? result.filter(chain => debugFilterChainIds.includes(chain.blockchainId)) : result;
// Ensure data directory exists
if (!fs.existsSync("./data")) {
    fs.mkdirSync("./data", { recursive: true });
}

fs.writeFileSync("./prod_chains.json", JSON.stringify(finalResult, null, 2));
console.log(`Saved ${finalResult.length} chains in prod_chains.json${debugFilterChainIds ? ` (limited to ${debugFilterChainIds})` : ''}`);
