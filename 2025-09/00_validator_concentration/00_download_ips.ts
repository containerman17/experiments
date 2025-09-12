interface ValidatorNode {
    nodeId: string;
    version: string;
    trackedSubnets: string[];
    lastAttempted: number;
    lastSeenOnline: number;
    ip: string;
}

async function fetchValidatorIPs(): Promise<Map<string, string>> {
    try {
        const response = await fetch('https://validator-discovery-asia.fly.dev/');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const validators: ValidatorNode[] = await response.json();
        const nodeIdToIP = new Map<string, string>();

        validators.forEach(validator => {
            nodeIdToIP.set(validator.nodeId, validator.ip);
        });

        return nodeIdToIP;
    } catch (error) {
        console.error('Error fetching validator data:', error);
        throw error;
    }
}

const nodeIdToIP = await fetchValidatorIPs();

console.log('Fetched validator IPs:');
for (const [nodeId, ip] of nodeIdToIP) {
    console.log(`${nodeId} -> ${ip}`);
}

console.log(`Total validators: ${nodeIdToIP.size}`);
import fs from 'fs';
fs.writeFileSync('nodeIdToIP.json', JSON.stringify(Object.fromEntries(nodeIdToIP), null, 2));
