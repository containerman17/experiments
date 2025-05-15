#!/usr/bin/env deno

interface Blockchain {
    createBlockTimestamp: number;
    createBlockNumber: string;
    blockchainId: string;
    vmId: string;
    subnetId: string;
    blockchainName: string;
    evmChainId?: number; // Based on the example, this can be missing
}

interface ApiResponse {
    blockchains: Blockchain[];
    nextPageToken?: string;
}

async function fetchChainsPage(nextPageToken?: string): Promise<ApiResponse> {
    console.log("fetching chains page", nextPageToken);
    const pageSize = 100;
    let url = `https://glacier-api.avax.network/v1/networks/fuji/blockchains?pageSize=${pageSize}`;
    if (nextPageToken) {
        url += `&pageToken=${nextPageToken}`;
    }
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch chains: ${response.statusText}`);
    }
    return response.json() as Promise<ApiResponse>;
}

async function fetchAllChains() {
    const allBlockchains: Blockchain[] = [];
    let nextPageToken: string | undefined = undefined;

    do {
        const page = await fetchChainsPage(nextPageToken);
        allBlockchains.push(...page.blockchains);
        nextPageToken = page.nextPageToken;
    } while (nextPageToken);

    return allBlockchains; // Optionally return all blockchains if needed elsewhere
}

//for each vmId, count the number of chains
const allBlockchains = await fetchAllChains();

//for each vmId, count the number of chains
const vmStats: Record<string, number> = {};
for (const blockchain of allBlockchains) {
    if (blockchain.blockchainId === "i9gFpZQHPLcGfZaQLiwFAStddQD7iTKBpFfurPFJsXm1CkTZK") {
        console.log(blockchain);
    }

    if (vmStats[blockchain.vmId]) {
        vmStats[blockchain.vmId]++;
    } else {
        vmStats[blockchain.vmId] = 1;
    }
}

const sortedVmStats = Object.entries(vmStats)
    .sort(([, a], [, b]) => b - a)
    .reduce((obj, [key, value]) => {
        obj[key] = value;
        return obj;
    }, {} as Record<string, number>);

console.log("VM Stats sorted by number of chains:");
console.log(sortedVmStats);
