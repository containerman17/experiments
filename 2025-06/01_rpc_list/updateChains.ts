let readme = `
# Avalanche L1s public RPC URLs list
`;

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { getGlacierChains, listAllBlockchains } from './lib/glacier.ts'
import { isValidated } from './lib/pApi.ts';
import { fetchEVMChainId, fetchLastBlockNumber } from './lib/evm.ts'

const knownNonEvmChains = [
    "2oYMBNV4eNHyqk2fjjV5nVQLDbtmNJzq5s3qs3Lo6ftnC6FByM", // X-Chain
    "11111111111111111111111111111111LpoYY" // P-Chain
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
    lastBlockNumber: string;
}

interface ChainWithoutRpc extends ChainData {
    glacierChainId?: string;
}

// Load comments from rpcComments.json
function loadComments(): Record<string, string> {
    try {
        const commentsPath = path.join(dirname(fileURLToPath(import.meta.url)), 'data', 'rpcComments.json');
        const commentsData = fs.readFileSync(commentsPath, 'utf8');
        return JSON.parse(commentsData);
    } catch (error) {
        console.warn('Could not load rpcComments.json:', error);
        return {};
    }
}

// Format number with thousands separator
function formatNumber(value: string): string {
    if (!isNaN(Number(value))) {
        return Number(value).toLocaleString();
    }
    return value;
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

    return validatedResults.filter(Boolean).filter(chainId => !knownNonEvmChains.includes(chainId as string)) as string[];
}

// Fetch EVM chain details for chains with RPC
async function fetchChainDetails(rpcUrl: string): Promise<{ evmChainId: string; lastBlockNumber: string }> {
    let evmChainId = 'N/A';
    let lastBlockNumber = 'N/A';

    try {
        const chainId = await fetchEVMChainId(rpcUrl);
        evmChainId = chainId?.toString() || 'Error';
    } catch {
        evmChainId = 'Error';
    }

    try {
        const blockNumber = await fetchLastBlockNumber(rpcUrl);
        lastBlockNumber = blockNumber?.toString() || 'Error';
    } catch {
        lastBlockNumber = 'Error';
    }

    return { evmChainId, lastBlockNumber };
}

// Split chains into those with and without RPC URLs
function categorizeChains(
    validatedChains: string[],
    blockchains: any[],
    officialRpcUrls: Map<string, string>,
    glacierChains: any[],
    comments: Record<string, string>
): { withRpc: ChainData[], withoutRpc: ChainData[] } {
    const withRpc: ChainData[] = [];
    const withoutRpc: ChainData[] = [];

    for (const blockchainId of validatedChains) {
        const rpcUrl = officialRpcUrls.get(blockchainId);
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

        if (rpcUrl && rpcUrl.trim() !== '') {
            withRpc.push({ ...baseChain, rpcUrl });
        } else {
            withoutRpc.push(baseChain);
        }
    }

    return { withRpc, withoutRpc };
}



// Generate table for chains with RPC URLs
async function generateWithRpcTable(chainsWithRpc: ChainData[]): Promise<string> {
    let table = `\n\n## Chains with Public RPC URLs (${chainsWithRpc.length})\n\n| Chain Name | Blockchain ID | RPC URL | EVM Chain ID | Last Block | Comment |\n|------------|---------------|---------|--------------|------------|---------|\n`;

    const chainDetails = await Promise.all(
        chainsWithRpc.map(async (chain) => {
            const { evmChainId, lastBlockNumber } = await fetchChainDetails(chain.rpcUrl!);
            return { ...chain, evmChainId, lastBlockNumber } as ChainWithRpc;
        })
    );

    for (const chain of chainDetails) {
        const formattedBlockNumber = formatNumber(chain.lastBlockNumber);
        table += `| ${chain.chainName} | ${chain.blockchainId} | ${chain.rpcUrl} | ${chain.evmChainId} | ${formattedBlockNumber} | ${chain.comment || ''} |\n`;
    }

    return table;
}

// Generate table for chains without RPC URLs
function generateWithoutRpcTable(chainsWithoutRpc: ChainData[]): string {
    let table = `\n\n## Chains without Public RPC URLs (${chainsWithoutRpc.length})\n\n| Chain Name | Blockchain ID | EVM Chain ID | Comment |\n|------------|---------------|--------------|----------|\n`;

    for (const chain of chainsWithoutRpc) {
        const comment = chain.comment || 'TODO: investigate';
        table += `| ${chain.chainName} | ${chain.blockchainId} | ${chain.glacierChainId || 'N/A'} | ${comment} |\n`;
    }

    return table;
}

// Generate chains.json file
async function generateChainsJson(chainsWithRpc: ChainData[], chainsWithoutRpc: ChainData[]): Promise<void> {
    const chainsWithRpcDetails = await Promise.all(
        chainsWithRpc.map(async (chain) => {
            const { evmChainId, lastBlockNumber } = await fetchChainDetails(chain.rpcUrl!);
            return {
                chainName: chain.chainName,
                blockchainId: chain.blockchainId,
                subnetId: chain.subnetId,
                rpcUrl: chain.rpcUrl,
                evmChainId,
                lastBlockNumber,
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
        lastBlockNumber: null,
        glacierChainId: chain.glacierChainId,
        comment: chain.comment || 'TODO: investigate'
    }));

    const allChains = [...chainsWithRpcDetails, ...chainsWithoutRpcDetails];

    const chainsJsonPath = path.join(dirname(fileURLToPath(import.meta.url)), 'data', 'chains.json');
    fs.writeFileSync(chainsJsonPath, JSON.stringify(allChains, null, 2));
}

// Main execution
try {
    const comments = loadComments();
    const glacierChains = await getGlacierChains('mainnet');
    const officialRpcUrls: Map<string, string> = new Map(
        glacierChains.map(chain => [chain.platformChainId, chain.rpcUrl])
    );
    const blockchains = await listAllBlockchains('mainnet');
    const validatedChains = await getValidatedChains();

    const { withRpc, withoutRpc } = categorizeChains(
        validatedChains,
        blockchains,
        officialRpcUrls,
        glacierChains,
        comments
    );

    readme += await generateWithRpcTable(withRpc);
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
