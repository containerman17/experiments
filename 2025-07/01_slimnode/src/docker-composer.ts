import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { database } from './database.js';
import path from 'path';

interface ComposeService {
    image: string;
    container_name: string;
    ports?: string[];
    volumes?: string[];
    environment: Record<string, string>;
    restart: string;
    networks?: string[];
    network_mode?: string;
    command?: string;
}

interface ComposeFile {
    services: Record<string, ComposeService>;
    networks: {
        avalanche: {
            driver: string;
        };
    };
}

export function generateDockerCompose(): void {
    const nodes = database.getAllNodes();
    const compose: ComposeFile = {
        services: {},
        networks: {
            avalanche: {
                driver: 'bridge'
            }
        }
    };

    // Generate service for each node
    nodes.forEach((nodeId, index) => {
        const nodeNum = index + 1;
        const httpPort = 9650 + (index * 2);
        const stakePort = 9651 + (index * 2);
        const subnets = database.getNodeSubnets(nodeId);

        compose.services[nodeId] = {
            image: 'avaplatform/avalanchego:latest',
            container_name: nodeId,
            ports: [
                `${httpPort}:${httpPort}`,
                `${stakePort}:${stakePort}`
            ],
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
            networks: ['avalanche']
        };
    });

    // Add Cloudflare tunnel service - needs host network to access API on host:3000
    compose.services['tunnel'] = {
        image: 'cloudflare/cloudflared:latest',
        container_name: 'tunnel',
        environment: {
            TODO_ADD_TUNNEL_TOKEN: "'TODO:'"
            // TUNNEL_TOKEN: '${CLOUDFLARE_TUNNEL_TOKEN}'
        },
        restart: 'unless-stopped',
        network_mode: 'host',
        command: 'tunnel --url http://localhost:3000'
    };

    // Write to file
    const yamlContent = generateYaml(compose);
    const composePath = path.join(process.cwd(), 'compose.yml');
    writeFileSync(composePath, yamlContent);
    console.log('Docker compose file regenerated');

    // TASK.md requirement: "call docker compose up -d" on any database change
    try {
        execSync('docker compose up -d', {
            cwd: process.cwd(),
            stdio: 'inherit'
        });
        console.log('Docker containers restarted with new configuration');
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
