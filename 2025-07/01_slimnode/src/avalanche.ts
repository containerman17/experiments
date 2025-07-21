const AVALANCHE_RPC_URL = 'http://localhost:9650';

interface SubnetInfo {
    exists: boolean;
    chainId?: string;
}

// Check if a subnet exists on the Avalanche network
export async function checkSubnetExists(subnetId: string): Promise<boolean> {
    try {
        const response = await fetch(`${AVALANCHE_RPC_URL}/ext/P`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'platform.getSubnet',
                params: { subnetID: subnetId },
                id: 1
            })
        });

        const data = await response.json();
        // TASK.md: check if this request returns a result, and not error field
        return !!data.result && !data.error;
    } catch (error) {
        console.error('Error checking subnet existence:', error);
        throw new Error('Failed to validate subnet');
    }
}

// Get subnetId from chainId (with caching)
const chainIdCache = new Map<string, { subnetId: string; timestamp: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export async function getSubnetIdFromChainId(chainId: string): Promise<string | null> {
    // Check cache first
    const cached = chainIdCache.get(chainId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.subnetId;
    }

    try {
        const response = await fetch(`${AVALANCHE_RPC_URL}/ext/bc/P`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'platform.getTx',
                params: {
                    txID: chainId,
                    encoding: 'json'
                },
                id: 1
            })
        });

        const data = await response.json();

        if (data.result?.tx?.unsignedTx?.subnetID) {
            const subnetId = data.result.tx.unsignedTx.subnetID;
            chainIdCache.set(chainId, {
                subnetId,
                timestamp: Date.now()
            });
            return subnetId;
        }

        return null;
    } catch (error) {
        console.error('Error getting subnet from chain ID:', error);
        return null;
    }
} 
