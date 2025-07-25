import { writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { database } from './database.js';
import path from 'path';
import { checkNodeBootstrap, getNodeId, getNodeIP } from './avalanche.js';

interface ComposeService {
    image: string;
    container_name: string;
    ports?: string[];
    volumes?: string[];
    environment?: Record<string, string>;
    restart: string;
    networks?: string[];
    network_mode?: string;
    command?: string;
    cpus?: string;
    mem_limit?: string;
}

interface ComposeFile {
    services: Record<string, ComposeService>;
    networks: {
        avalanche: {
            driver: string;
        };
    };
}

export const getPorts = (index: number) => {
    return {
        httpPort: 9652 + (index * 2),
        stakePort: 9653 + (index * 2)
    }
}


// Fast bootstrap: copy bootnode data to new nodes
function copyBootnodeToNewNodes(): void {
    const nodes = database.getAllNodes();
    const nodesToCopy: string[] = [];

    // Check which node directories don't exist
    for (const nodeId of nodes) {
        const nodeDataPath = `/avadata/${nodeId}`;
        if (!existsSync(nodeDataPath)) {
            nodesToCopy.push(nodeId);
        }
    }

    if (nodesToCopy.length === 0) {
        console.log('All node data directories already exist, skipping bootstrap copy');
        return;
    }

    console.log(`Fast bootstrap: copying bootnode data to ${nodesToCopy.length} new nodes: ${nodesToCopy.join(', ')}`);

    try {
        // Stop bootnode
        console.log('Stopping bootnode for data copy...');
        execSync('docker stop bootnode', { stdio: 'inherit' });

        // Copy bootnode data to each new node
        for (const nodeId of nodesToCopy) {
            console.log(`Copying bootnode data to ${nodeId}...`);
            execSync(`sudo cp -r /avadata/bootnode/ /avadata/${nodeId}/`, { stdio: 'inherit' });

            // Remove staking directory from copied data
            console.log(`Removing staking directory from ${nodeId}...`);
            execSync(`sudo rm -rf /avadata/${nodeId}/staking`, { stdio: 'inherit' });
        }

        console.log('Fast bootstrap copy completed');
    } catch (error) {
        console.error('Error during fast bootstrap copy:', error);
        throw error;
    }
}

export async function generateDockerCompose(): Promise<void> {
    const nodes = database.getAllNodes();

    // Check if bootnode is bootstrapped
    const bootnodeBootstrapped = await checkNodeBootstrap(9650);
    console.log(`Bootnode bootstrapped: ${bootnodeBootstrapped}`);

    // If bootnode is bootstrapped, do fast bootstrap copy for new nodes
    if (bootnodeBootstrapped) {
        copyBootnodeToNewNodes();
    }

    const compose: ComposeFile = {
        services: {},
        networks: {
            avalanche: {
                driver: 'bridge'
            }
        }
    };

    // Add bootnode service - always uses ports 9650/9651
    compose.services['bootnode'] = {
        image: 'avaplatform/subnet-evm_avalanchego:latest',
        container_name: 'bootnode',
        volumes: [
            '/avadata/bootnode:/root/.avalanchego'
        ],
        environment: {
            AVAGO_PUBLIC_IP_RESOLUTION_SERVICE: 'opendns',
            AVAGO_HTTP_HOST: '0.0.0.0',
            AVAGO_PARTIAL_SYNC_PRIMARY_NETWORK: "true",
            AVAGO_NETWORK_ID: 'fuji',
            AVAGO_HTTP_ALLOWED_HOSTS: "'*'",
            AVAGO_HTTP_PORT: '9650',
            AVAGO_STAKING_PORT: '9651'
        },
        restart: 'unless-stopped',
        network_mode: 'host',
        cpus: '2',
        mem_limit: '2g'
    };

    let bootNodeId = await getNodeId(9650);
    const bootNodeIP = await getNodeIP(9650);


    // Only add subnet nodes if bootnode is bootstrapped
    if (bootnodeBootstrapped && bootNodeId && bootNodeIP) {
        // Generate service for each node - ports start from 9652/9653
        nodes.forEach((nodeId, index) => {

            const { httpPort, stakePort } = getPorts(index);
            const subnets = database.getNodeSubnets(nodeId);

            // All nodes bootstrap from the bootnode
            const avalanchegoArgs = ''//`./avalanchego --bootstrap-ips=${bootNodeIP} --bootstrap-ids="${bootNodeId}"`;

            compose.services[nodeId] = {
                image: 'avaplatform/subnet-evm_avalanchego:latest',
                container_name: nodeId,
                volumes: [
                    `/avadata/${nodeId}:/root/.avalanchego`
                ],
                environment: {
                    AVAGO_TRACK_SUBNETS: subnets.sort().join(',') || '',
                    AVAGO_PUBLIC_IP_RESOLUTION_SERVICE: 'opendns',
                    AVAGO_HTTP_HOST: '0.0.0.0',
                    AVAGO_PARTIAL_SYNC_PRIMARY_NETWORK: "true",
                    AVAGO_NETWORK_ID: 'fuji',
                    AVAGO_HTTP_ALLOWED_HOSTS: "'*'",
                    AVAGO_HTTP_PORT: `${httpPort}`,
                    AVAGO_STAKING_PORT: `${stakePort}`
                },
                restart: 'unless-stopped',
                network_mode: 'host',
                command: avalanchegoArgs,
                cpus: '1',
                mem_limit: '1g'
            };
        });
    } else {
        console.log('Bootnode not bootstrapped yet - only starting bootnode and tunnel');
    }

    // Add Cloudflare tunnel service - needs host network to access API on host:3000
    if (process.env.CLOUDFLARE_TUNNEL_TOKEN) {
        compose.services['tunnel'] = {
            image: 'cloudflare/cloudflared:latest',
            container_name: 'tunnel',
            restart: 'unless-stopped',
            network_mode: 'host',
            command: `tunnel --no-autoupdate run --token ${process.env.CLOUDFLARE_TUNNEL_TOKEN}`
        };
    }

    // Write to file
    const yamlContent = generateYaml(compose);
    const composePath = path.join(process.cwd(), 'compose.yml');
    writeFileSync(composePath, yamlContent);

    if (bootnodeBootstrapped) {
        console.log('Docker compose file regenerated with all nodes');
    } else {
        console.log('Docker compose file generated with bootnode only (waiting for bootstrap)');
    }

    // TASK.md requirement: "call docker compose up -d" on any database change
    try {
        execSync('docker compose up -d --remove-orphans', {
            cwd: process.cwd(),
            stdio: 'inherit'
        });

        if (bootnodeBootstrapped) {
            console.log('Docker containers restarted with new configuration');
        } else {
            console.log('Docker containers started (bootnode + tunnel only)');
        }
    } catch (error) {
        console.error('Failed to restart docker containers:', error);
    }
}

// Simple YAML generator (avoiding external dependencies)
function generateYaml(obj: any, indent = 0): string {
    const spaces = ' '.repeat(indent);
    let yaml = '';

    for (const [key, value] of Object.entries(obj)) {
        yaml += `${spaces}${key}:`;

        if (value === null || value === undefined) {
            yaml += ' ~\n';
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            yaml += ` ${value}\n`;
        } else if (Array.isArray(value)) {
            yaml += '\n';
            value.forEach(item => {
                yaml += `${spaces}  - ${item}\n`;
            });
        } else if (typeof value === 'object') {
            yaml += '\n';
            yaml += generateYaml(value, indent + 2);
        }
    }

    return yaml;
} 
