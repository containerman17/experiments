import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { database } from './database.js';
import path from 'path';

interface ComposeService {
    image: string;
    container_name: string;
    ports: string[];
    environment: Record<string, string>;
    restart: string;
    networks: string[];
}

interface ComposeFile {
    version: string;
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
        version: '3.8',
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
                `${httpPort}:9650`,
                `${stakePort}:9651`
            ],
            environment: {
                AVAGO_TRACK_SUBNETS: subnets.sort().join(',') || ''
            },
            restart: 'unless-stopped',
            networks: ['avalanche']
        };
    });

    // Add Cloudflare tunnel service (placeholder)
    compose.services['cloudflare-tunnel'] = {
        image: 'cloudflare/cloudflared:latest',
        container_name: 'cloudflare-tunnel',
        ports: [],
        environment: {
            TUNNEL_TOKEN: '${CLOUDFLARE_TUNNEL_TOKEN}'
        },
        restart: 'unless-stopped',
        networks: ['avalanche']
    };

    // Write to file
    const yamlContent = generateYaml(compose);
    const composePath = path.join(process.cwd(), 'docker-compose.yml');
    writeFileSync(composePath, yamlContent);
    console.log('Docker compose file regenerated');

    // Rebuild and restart containers as required by TASK.md
    try {
        execSync('docker compose up -d', {
            cwd: process.cwd(),
            stdio: 'pipe'
        });
        console.log('Docker containers restarted');
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
