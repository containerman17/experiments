import chains from './data/chains.json' assert { type: 'json' };
import nodeSubnets from './data/nodeSubnets.json' assert { type: 'json' };
import trackExtraChains from './data/trackExtraChains.json' assert { type: 'json' };
import { writeFileSync } from 'fs';
import { generateCompose } from './lib/generateCompose';
import { config } from 'dotenv';
config()

const subnetsToBlockchainId: Record<string, string[]> = {};
for (const chain of chains) {
    if (!subnetsToBlockchainId[chain.subnetId]) {
        subnetsToBlockchainId[chain.subnetId] = [];
    }
    if (chain.blockchainId) {
        subnetsToBlockchainId[chain.subnetId].push(chain.blockchainId);
    }
}

// Get chains without RPC URLs
const chainsWithoutRpc = chains.filter(chain => !chain.rpcUrl);

// Get blockchainIds from trackExtraChains
const extraBlockchainIds = trackExtraChains as string[];

// Find subnets for chains without RPC or in trackExtraChains
const subnetsToTrackSet = new Set<string>();
for (const chain of chainsWithoutRpc) {
    if (chain.subnetId) {
        subnetsToTrackSet.add(chain.subnetId);
    }
}

// Add subnets for chains in trackExtraChains
for (const chain of chains) {
    if (chain.blockchainId && extraBlockchainIds.includes(chain.blockchainId)) {
        if (chain.subnetId) {
            subnetsToTrackSet.add(chain.subnetId);
        }
    }
}

// Convert to array and filter out primary subnet
const PRIMARY_SUBNET_ID = "11111111111111111111111111111111LpoYY"
const subnetsToTrack = [...subnetsToTrackSet].filter(subnet => subnet !== PRIMARY_SUBNET_ID)

// Get all currently assigned subnets across all nodes
const currentlyAssigned = new Set();
Object.values(nodeSubnets).forEach((subnets: string[]) => {
    subnets.forEach(subnet => currentlyAssigned.add(subnet));
});

// Find new subnets that need to be assigned
const newSubnets = subnetsToTrack.filter(subnet => !currentlyAssigned.has(subnet));

console.log(`Tracking ${chainsWithoutRpc.length} chains without RPC`);
console.log(`Tracking ${extraBlockchainIds.length} chains from trackExtraChains`);
console.log(`Total subnets to track: ${subnetsToTrack.length}`);
console.log(`Found ${newSubnets.length} new subnets to assign:`, newSubnets);

// Assign new subnets to nodes
for (const subnet of newSubnets) {
    // Find the first node with less than 16 subnets
    let assigned = false;

    for (const [nodeId, subnets] of Object.entries(nodeSubnets)) {
        if (subnets.length < 16) {
            subnets.push(subnet);
            console.log(`Assigned subnet ${subnet} to node ${nodeId} (now has ${subnets.length} subnets)`);
            assigned = true;
            break;
        }
    }

    // If no existing node has space, create a new node
    if (!assigned) {
        const nextNodeId = Math.max(...Object.keys(nodeSubnets).map(Number)) + 1;
        nodeSubnets[nextNodeId] = [subnet];
        console.log(`Created new node ${nextNodeId} and assigned subnet ${subnet}`);
    }
}

// Write the updated nodeSubnets back to file
writeFileSync('./data/nodeSubnets.json', JSON.stringify(nodeSubnets, null, 4));

// Summary
console.log('\nFinal distribution:');
Object.entries(nodeSubnets).forEach(([nodeId, subnets]) => {
    console.log(`Node ${nodeId}: ${subnets.length} subnets`);
});

console.log(`\nTotal subnets being tracked: ${subnetsToTrack.length}`);

console.log(`Total subnets assigned: ${Object.values(nodeSubnets).flat().length}`);

const MEGANODE_DOMAIN = process.env.MEGANODE_DOMAIN
if (!MEGANODE_DOMAIN) throw new Error("MEGANODE_DOMAIN is not set. Put it into .env")

const compose = generateCompose(nodeSubnets, subnetsToBlockchainId, MEGANODE_DOMAIN)
writeFileSync('./data/meganode-compose.yml', compose,)
