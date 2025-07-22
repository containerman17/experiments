import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

interface NodeDatabase {
    [nodeId: string]: {
        [subnetId: string]: number; // timestamp
    };
}

async function checkNodeBootstrap(nodePort: number): Promise<boolean> {
    try {
        const response = await fetch(`http://127.0.0.1:${nodePort}/ext/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'info.isBootstrapped',
                params: {
                    chain: 'P'
                }
            })
        });

        const data = await response.json();
        return data.result?.isBootstrapped === true;
    } catch (error) {
        return false;
    }
}

async function checkNodePeerCount(nodePort: number): Promise<number> {
    try {
        const response = await fetch(`http://127.0.0.1:${nodePort}/ext/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'info.peers',
                params: {
                    nodeIDs: []
                }
            })
        });

        const data = await response.json();
        return data.result?.peers?.length || 0;
    } catch (error) {
        return 0;
    }
}

function restartFailedNodes(failedNodes: string[]): string[] {
    if (failedNodes.length === 0) {
        console.log('\n✅ No failed nodes to restart\n');
        return [];
    }

    console.log(`\nRestarting ${failedNodes.length} failed nodes...\n`);

    const restartedNodes: string[] = [];
    for (const nodeId of failedNodes) {
        try {
            console.log(`🔄 Restarting ${nodeId}...`);
            execSync(`docker restart ${nodeId}`, { stdio: 'inherit' });
            console.log(`✅ Successfully restarted ${nodeId}`);
            restartedNodes.push(nodeId);
        } catch (error) {
            console.log(`❌ Failed to restart ${nodeId}:`, error);
        }
    }

    return restartedNodes;
}

async function main() {
    const dataDir = process.env.DATA_DIR || './data';
    const filePath = path.join(dataDir, 'chains.json');

    // Parse command line arguments
    const args = process.argv.slice(2);
    const shouldRestart = args.includes('restart');

    if (!existsSync(filePath)) {
        console.log('❌ Database file not found at', filePath);
        process.exit(1);
    }

    let database: NodeDatabase;
    try {
        const fileContent = readFileSync(filePath, 'utf-8');
        database = JSON.parse(fileContent);
    } catch (error) {
        console.log('❌ Failed to read database file:', error);
        process.exit(1);
    }

    const nodes = Object.keys(database).sort();
    console.log(`Checking ${nodes.length} nodes...\n`);

    // First pass: check status and identify failed nodes
    const failedNodes: string[] = [];
    let totalSubnets = 0;

    // Check bootnode first (always on port 9650)
    console.log('Checking bootnode...');
    const bootnodeBootstrapped = await checkNodeBootstrap(9650);
    const bootnodePeerCount = await checkNodePeerCount(9650);
    const bootnodeStatus = bootnodeBootstrapped ? '✅' : '❌';

    if (!bootnodeBootstrapped) {
        failedNodes.push('bootnode');
    }

    console.log(`${bootnodeStatus} bootnode (port 9650) - bootstrap node, ${bootnodePeerCount} peers\n`);

    // Check subnet nodes (start from port 9652)
    for (let i = 0; i < nodes.length; i++) {
        const nodeId = nodes[i];
        const nodePort = 9652 + (i * 2);  // Start from 9652 (bootnode uses 9650)
        const subnetCount = Object.keys(database[nodeId]).length;
        totalSubnets += subnetCount;

        const isBootstrapped = await checkNodeBootstrap(nodePort);
        const peerCount = await checkNodePeerCount(nodePort);
        const status = isBootstrapped ? '✅' : '❌';

        if (!isBootstrapped) {
            failedNodes.push(nodeId);
        }

        console.log(`${status} ${nodeId} (port ${nodePort}) - ${subnetCount} subnets, ${peerCount} peers`);
    }

    // Restart failed nodes if flag is provided
    let restartedNodes: string[] = [];
    if (shouldRestart) {
        restartedNodes = restartFailedNodes(failedNodes);

        if (restartedNodes.length > 0) {
            console.log('Waiting 10 seconds for nodes to restart...\n');
            await new Promise(resolve => setTimeout(resolve, 10000));

            console.log('Rechecking restarted nodes...\n');

            // Second pass: check only restarted nodes
            for (const nodeId of restartedNodes) {
                if (nodeId === 'bootnode') {
                    const isBootstrapped = await checkNodeBootstrap(9650);
                    const peerCount = await checkNodePeerCount(9650);
                    const status = isBootstrapped ? '✅' : '❌';
                    console.log(`${status} bootnode (port 9650) - bootstrap node, ${peerCount} peers 🔄`);
                } else {
                    const nodeIndex = nodes.indexOf(nodeId);
                    const nodePort = 9652 + (nodeIndex * 2);  // Start from 9652 (bootnode uses 9650)
                    const subnetCount = Object.keys(database[nodeId]).length;

                    const isBootstrapped = await checkNodeBootstrap(nodePort);
                    const peerCount = await checkNodePeerCount(nodePort);
                    const status = isBootstrapped ? '✅' : '❌';

                    console.log(`${status} ${nodeId} (port ${nodePort}) - ${subnetCount} subnets, ${peerCount} peers 🔄`);
                }
            }
        }
    }

    // Calculate final totals
    let finalBootstrappedCount = 0;

    // Check bootnode
    const finalBootnodeBootstrapped = await checkNodeBootstrap(9650);
    if (finalBootnodeBootstrapped) finalBootstrappedCount++;

    // Check subnet nodes
    for (let i = 0; i < nodes.length; i++) {
        const nodePort = 9652 + (i * 2);  // Start from 9652 (bootnode uses 9650)
        const isBootstrapped = await checkNodeBootstrap(nodePort);
        if (isBootstrapped) finalBootstrappedCount++;
    }

    // Show totals
    console.log('\n' + '='.repeat(50));
    console.log(`Total nodes: ${nodes.length + 1} (1 bootnode + ${nodes.length} subnet nodes)`);
    console.log(`Bootstrapped nodes: ${finalBootstrappedCount}`);
    console.log(`Failed nodes: ${(nodes.length + 1) - finalBootstrappedCount}`);
    console.log(`Total subnets: ${totalSubnets}`);
    if (shouldRestart) {
        console.log(`Restarted nodes: ${restartedNodes.length} (${restartedNodes.join(', ')})`);
    }
    console.log('='.repeat(50));
}

main().catch(console.error);
