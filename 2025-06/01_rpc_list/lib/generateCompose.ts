import YAML from 'yaml'

// Function to generate a service configuration for a single subnet
function generateSubnetService(subnetId: string, httpPort: number, stakingPort: number) {
    return {
        image: 'containerman17/subnet-evm-plus:latest',
        container_name: subnetId,
        restart: 'always',
        networks: ['default'],
        ports: [
            `127.0.0.1:${httpPort}:${httpPort}`,
            `${stakingPort}:${stakingPort}`
        ],
        volumes: [
            `~/nodes/${subnetId}/:/root/.avalanchego`
        ],
        environment: [
            `AVAGO_PARTIAL_SYNC_PRIMARY_NETWORK=true`,
            'AVAGO_PUBLIC_IP_RESOLUTION_SERVICE=opendns',
            'AVAGO_HTTP_HOST=0.0.0.0',
            'AVAGO_HTTP_ALLOWED_HOSTS=*',
            `AVAGO_HTTP_PORT=${httpPort}`,
            `AVAGO_STAKING_PORT=${stakingPort}`,
            `AVAGO_TRACK_SUBNETS=${subnetId}`,
            `AVAGO_DB_TYPE=pebbledb`,
        ],
        logging: {
            driver: 'json-file',
            options: {
                'max-size': '50m',
                'max-file': '3'
            }
        }
    }
}

// Function to generate nginx configuration
function generateNginxConfig(serviceConfigs: { serviceName: string, httpPort: number, blockchainIds: string[] }[]): string {
    let upstreams = ''
    let locations = ''

    // Generate upstream blocks and location blocks
    serviceConfigs.forEach(config => {
        config.blockchainIds.forEach(blockchainId => {
            const upstreamName = `backend_${blockchainId.replace(/-/g, '_')}`

            upstreams += `
    upstream ${upstreamName} {
        server ${config.serviceName}:${config.httpPort};
    }`

            locations += `
        location /ext/bc/${blockchainId}/ {
            limit_conn perip 500;
            proxy_pass http://${upstreamName};
            proxy_connect_timeout 5s;
            proxy_send_timeout 300s;
            proxy_read_timeout 300s;
            
            # WebSocket support
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }`
        })
    })

    return `events {}
http {
    # Concurrent connection limiting: max 500 active connections per IP
    limit_conn_zone $binary_remote_addr zone=perip:10m;
    
    # WebSocket upgrade mapping
    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }
    ${upstreams}
    
    server {
        listen 80;
        ${locations}
        
        location / {
            return 200 'RPC Gateway OK\\n';
            add_header Content-Type text/plain;
        }
    }
}`
}

export function generateCompose(subnets: string[]): string {
    const composeObject: {
        services: { [key: string]: any }
    } = {
        services: {}
    }

    let nextHttpPort = 9000

    // Generate one service per subnet
    subnets.forEach((subnetId) => {
        composeObject.services[subnetId] = generateSubnetService(
            subnetId,
            nextHttpPort,
            nextHttpPort + 1
        )

        nextHttpPort += 2
    })

    // Add nginx service with volume mount for config
    composeObject.services.nginx = {
        image: 'nginx:1.25-alpine',
        container_name: 'nginx',
        volumes: [
            './nginx.conf:/etc/nginx/nginx.conf:ro'
        ],
        ports: [
            '127.0.0.1:8080:80'
        ],
        restart: 'unless-stopped',
        depends_on: Object.keys(composeObject.services).filter(s => s !== 'nginx')
    }

    return YAML.stringify(composeObject)
}

// Export the nginx config generator for use in updateMeganode.ts
export { generateNginxConfig }
