let readme = `
# Avalanche L1s public RPC URLs list
`;

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { getGlacierChains, listAllBlockchains } from './lib/glacier.ts'
import { isValidated } from './lib/pApi.ts';
import { fetchEVMChainId, fetchLastBlockNumber, fetchBlockByNumber, fetchBlockchainIDFromPrecompile } from './lib/evm.ts'
import { getIndexerStatus } from './lib/indexer.ts'

const ignoreChains = [
    "2oYMBNV4eNHyqk2fjjV5nVQLDbtmNJzq5s3qs3Lo6ftnC6FByM", // X-Chain
    "11111111111111111111111111111111LpoYY", // P-Chain
]

interface ChainData {
    chainName: string;
    blockchainId: string;
    subnetId: string;
    rpcUrl?: string;
    glacierChainId?: string;
    comment?: string;
}

interface ChainWithRpc extends ChainData {
    rpcUrl: string;
    evmChainId: string;
    rawBlocksCount: number;
}

interface ChainWithoutRpc extends ChainData {
    glacierChainId?: string;
}

// Load comments from rpcComments.json
function loadComments(): Record<string, string> {
    const commentsPath = path.join(dirname(fileURLToPath(import.meta.url)), 'data', 'rpcComments.json');
    const commentsData = fs.readFileSync(commentsPath, 'utf8');
    return JSON.parse(commentsData);
}

// Load extra RPCs from extraRpcs.json
function loadExtraRpcs(): Record<string, string> {
    const extraRpcsPath = path.join(dirname(fileURLToPath(import.meta.url)), 'data', 'extraRpcs.json');
    const extraRpcsData = fs.readFileSync(extraRpcsPath, 'utf8');
    return JSON.parse(extraRpcsData);

}


// Get validated chains
async function getValidatedChains(): Promise<string[]> {
    const blockchains = await listAllBlockchains('mainnet')

    const validatedResults = await Promise.all(
        blockchains.map(async (blockchain) => {
            const isValid = await isValidated(blockchain.subnetId);
            return isValid ? blockchain.blockchainId : null;
        })
    );

    return validatedResults.filter(Boolean).filter(chainId => !ignoreChains.includes(chainId as string)) as string[];
}

// Test if an RPC URL is working
async function testRpcUrl(rpcUrl: string, expectedBlockchainId: string): Promise<boolean> {
    try {
        // First check if we can get chainId
        await fetchEVMChainId(rpcUrl);

        // Then check if we can get block 0x1 (block number 1)
        // This tests if the RPC has historical data
        // const block = await fetchBlockByNumber(rpcUrl, "latest");
        // const latestBlockNumber = parseInt(block.number, 16)
        // const midBlockNumber = latestBlockNumber / 2
        // //checking if historical data is available
        // await fetchBlockByNumber(rpcUrl, `0x${midBlockNumber.toString(16)}`)
        const blockchainId = await fetchBlockchainIDFromPrecompile(rpcUrl);
        const precompileIsAbsent = blockchainId === "45PJLL"

        if (blockchainId !== expectedBlockchainId && !precompileIsAbsent) {
            console.log(`❌❌❌ Blockchain ID mismatch for ${rpcUrl}: ${blockchainId} !== ${expectedBlockchainId}. This is not good.`)
            process.exit(1);
        }

        return true;
    } catch (error) {
        // console.log(rpcUrl, error)
        return false;
    }
}

// Find working RPC URL for a chain
async function findWorkingRpcUrl(blockchainId: string, officialRpcUrl?: string, extraRpcUrl?: string): Promise<string | undefined> {
    const meganodeUrl = `https://meganode.solokhin.com/ext/bc/${blockchainId}/rpc`;

    // Try extra RPC first
    if (extraRpcUrl && extraRpcUrl.trim() !== '') {
        const isWorking = await testRpcUrl(extraRpcUrl, blockchainId);
        if (isWorking) {
            console.log(`RPC for ${blockchainId}: 🔧 extra`);
            return extraRpcUrl;
        }
    }

    // Try meganode RPC second
    const isWorking = await testRpcUrl(meganodeUrl, blockchainId);
    if (isWorking) {
        console.log(`RPC for ${blockchainId}: 🐊 Meganode`);
        return meganodeUrl;
    }

    // Try official RPC last
    if (officialRpcUrl && officialRpcUrl.trim() !== '') {
        const isWorking = await testRpcUrl(officialRpcUrl, blockchainId);
        if (isWorking) {
            console.log(`RPC for ${blockchainId}: ✅ official`);
            return officialRpcUrl;
        } else {
            console.log(`🤔 Weird, the official RPC is not working: ${officialRpcUrl}.`)
        }
    }

    console.log(`RPC for ${blockchainId}: no working rpc found ❌`);
    return undefined;
}

// Convert block number to bucket string
function numberToBucket(blockNumber: string): string {
    const n = Number(blockNumber);
    if (isNaN(n) || n < 0) return '0+';
    if (n < 10) return '0+';
    if (n < 100) return '10+';
    if (n < 1000) return '100+';
    if (n < 10000) return '1k+';
    if (n < 100000) return '10k+';
    if (n < 1000000) return '100k+';
    if (n < 10000000) return '1m+';
    if (n < 100000000) return '10m+';
    if (n < 1000000000) return '100m+';
    if (n < 10000000000) return '1b+';
    return '1b+';
}

// Calculate estimated transaction count from indexer status
async function getEstimatedTxCount(blockchainId: string): Promise<string | null> {
    try {
        const status = await getIndexerStatus(blockchainId);
        const estimatedTxCount = Math.round(
            status.totalTxCount / (status.lastProcessedBlock || 1) * status.latestBlockNumber
        );
        return numberToBucket(estimatedTxCount.toString());
    } catch (error) {
        return null;
    }
}

// Fetch EVM chain details for chains with RPC
async function fetchChainDetails(rpcUrl: string, blockchainId: string): Promise<{ evmChainId: string; rawBlocksCount: number; estimatedTxCount: string | null }> {
    let evmChainId = 'N/A';
    let rawBlocksCount = 0;

    const chainId = await fetchEVMChainId(rpcUrl);
    evmChainId = chainId?.toString() || 'Error';

    const blockNumber = await fetchLastBlockNumber(rpcUrl);
    rawBlocksCount = Number(blockNumber?.toString() || '0');

    const estimatedTxCount = await getEstimatedTxCount(blockchainId);

    return { evmChainId, rawBlocksCount, estimatedTxCount };
}

// Split chains into those with and without RPC URLs
async function categorizeChains(
    validatedChains: string[],
    blockchains: any[],
    officialRpcUrls: Map<string, string>,
    extraRpcUrls: Record<string, string>,
    glacierChains: any[],
    comments: Record<string, string>
): Promise<{ withRpc: ChainData[], withoutRpc: ChainData[] }> {
    const chainPromises = validatedChains.map(async (blockchainId) => {
        const officialRpcUrl = officialRpcUrls.get(blockchainId);
        const extraRpcUrl = extraRpcUrls[blockchainId];
        const blockchain = blockchains.find(b => b.blockchainId === blockchainId);
        const chainName = blockchain?.blockchainName || 'Unknown';
        const subnetId = blockchain?.subnetId || 'Unknown';
        const glacierChain = glacierChains.find(g => g.platformChainId === blockchainId);
        const comment = comments[blockchainId];

        const baseChain: ChainData = {
            chainName,
            blockchainId,
            subnetId,
            glacierChainId: glacierChain?.chainId,
            comment
        };

        // Try to find a working RPC URL (official first, then extra, then meganode)
        const workingRpcUrl = await findWorkingRpcUrl(blockchainId, officialRpcUrl, extraRpcUrl);

        if (workingRpcUrl) {
            return { ...baseChain, rpcUrl: workingRpcUrl } as ChainData;
        } else {
            return baseChain;
        }
    });

    const results = await Promise.all(chainPromises);

    const withRpc: ChainData[] = [];
    const withoutRpc: ChainData[] = [];

    for (const result of results) {
        if (result.rpcUrl) {
            withRpc.push(result);
        } else {
            withoutRpc.push(result);
        }
    }

    return { withRpc, withoutRpc };
}

// Generate table for chains with RPC URLs
async function generateWithRpcTable(chainsWithRpc: ChainData[], officialExplorerUrls: Map<string, string>): Promise<string> {
    let content = `\n\n## Chains with Public RPC URLs (${chainsWithRpc.length})\n\n`;

    const chainDetails = await Promise.all(
        chainsWithRpc.map(async (chain) => {
            const { evmChainId, rawBlocksCount, estimatedTxCount } = await fetchChainDetails(chain.rpcUrl!, chain.blockchainId);
            return { ...chain, evmChainId, rawBlocksCount, estimatedTxCount } as ChainWithRpc & { estimatedTxCount: string | null };
        })
    );

    // Sort by block count descending
    chainDetails.sort((a, b) => {
        return b.rawBlocksCount - a.rawBlocksCount;
    });

    for (const chain of chainDetails) {
        const blocksCount = numberToBucket(chain.rawBlocksCount.toString());
        const explorerUrl = officialExplorerUrls.get(chain.blockchainId) || '❌';
        content += `**${chain.chainName}**\n`;
        content += `- Blocks Count: ${blocksCount}\n`;
        content += `- Estimated Tx Count: ${chain.estimatedTxCount || 'Unknown'}\n`;
        content += `- EVM Chain ID: ${chain.evmChainId}\n`;
        content += `- Blockchain ID: ${chain.blockchainId}\n`;
        content += `- RPC URL: ${chain.rpcUrl}\n`;
        content += `- Explorer URL: ${explorerUrl}\n`;
        if (chain.comment) {
            content += `- Comment: ${chain.comment}\n`;
        }
        content += `\n`;
    }

    return content;
}

// Generate table for chains without RPC URLs
function generateWithoutRpcTable(chainsWithoutRpc: ChainData[]): string {
    let content = `\n\n## Chains without Public RPC URLs (${chainsWithoutRpc.length})\n\n`;

    for (const chain of chainsWithoutRpc) {
        const comment = chain.comment || 'TODO: investigate';
        content += `**${chain.chainName}**\n`;
        content += `- EVM Chain ID: ${chain.glacierChainId || 'N/A'}\n`;
        content += `- Blockchain ID: ${chain.blockchainId}\n`;
        content += `- Comment: ${comment}\n`;
        content += `\n`;
    }

    return content;
}

// Generate chains.json file
async function generateChainsJson(chainsWithRpc: ChainData[], chainsWithoutRpc: ChainData[]): Promise<void> {
    const chainsWithRpcDetails = await Promise.all(
        chainsWithRpc.map(async (chain) => {
            const { evmChainId, rawBlocksCount, estimatedTxCount } = await fetchChainDetails(chain.rpcUrl!, chain.blockchainId);
            return {
                chainName: chain.chainName,
                blockchainId: chain.blockchainId,
                subnetId: chain.subnetId,
                rpcUrl: chain.rpcUrl,
                evmChainId,
                blocksCount: numberToBucket(rawBlocksCount.toString()),
                estimatedTxCount,
                glacierChainId: chain.glacierChainId,
                comment: chain.comment || null
            };
        })
    );

    const chainsWithoutRpcDetails = chainsWithoutRpc.map(chain => ({
        chainName: chain.chainName,
        blockchainId: chain.blockchainId,
        subnetId: chain.subnetId,
        rpcUrl: null,
        evmChainId: chain.glacierChainId || null,
        blocksCount: null,
        estimatedTxCount: null,
        glacierChainId: chain.glacierChainId,
        comment: chain.comment || 'TODO: investigate'
    }));

    const allChains = [...chainsWithRpcDetails, ...chainsWithoutRpcDetails];

    // Sort by blockchainId
    allChains.sort((a, b) => a.blockchainId.localeCompare(b.blockchainId));

    const chainsJsonPath = path.join(dirname(fileURLToPath(import.meta.url)), 'data', 'chains.json');
    fs.writeFileSync(chainsJsonPath, JSON.stringify(allChains, null, 2));
}


// Main execution
try {
    const comments = loadComments();
    const extraRpcs = loadExtraRpcs();
    const glacierChains = await getGlacierChains('mainnet');

    const officialExplorerUrls: Map<string, string> = new Map(
        glacierChains.map(chain => [chain.platformChainId, chain.explorerUrl])
    );

    const officialRpcUrls: Map<string, string> = new Map(
        glacierChains.map(chain => [chain.platformChainId, chain.rpcUrl])
    );
    const blockchains = await listAllBlockchains('mainnet');
    const validatedChains = await getValidatedChains();

    const { withRpc, withoutRpc } = await categorizeChains(
        validatedChains,
        blockchains,
        officialRpcUrls,
        extraRpcs,
        glacierChains,
        comments,
    );

    readme += await generateWithRpcTable(withRpc, officialExplorerUrls);
    readme += generateWithoutRpcTable(withoutRpc);

    fs.writeFileSync(path.join(dirname(fileURLToPath(import.meta.url)), 'README.md'), readme);

    await generateChainsJson(withRpc, withoutRpc);

    console.log('README.md updated successfully');
    console.log('chains.json generated successfully');
    console.log(`Chains with RPC: ${withRpc.length}`);
    console.log(`Chains without RPC: ${withoutRpc.length}`);
    process.exit(0);
} catch (error) {
    console.error(error);
    process.exit(1);
}
