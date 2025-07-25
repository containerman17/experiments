import YAML from 'yaml'

// Interface for service configuration
interface ServiceConfig {
    serviceName: string
    containerName: string
    folderSuffix: string
    httpPort: number
    stakingPort: number
    subnetIds: string[]
    blockchainIds: string[]
    skipCChain: boolean
}

// Function to pad numbers with leading zeros
function padzero(num: number, size: number): string {
    return num.toString().padStart(size, '0')
}

// Function to generate a service configuration
function generateService(config: ServiceConfig) {
    return {
        image: 'containerman17/subnet-evm-plus:latest',
        container_name: config.containerName,
        restart: 'always',
        networks: ['default'],
        ports: [
            `127.0.0.1:${config.httpPort}:${config.httpPort}`,
            `${config.stakingPort}:${config.stakingPort}`
        ],
        volumes: [
            `~/nodes/${config.folderSuffix}/:/root/.avalanchego`
        ],
        environment: [
            `AVAGO_PARTIAL_SYNC_PRIMARY_NETWORK=${config.skipCChain ? 'true' : 'false'}`,
            'AVAGO_PUBLIC_IP_RESOLUTION_SERVICE=opendns',
            'AVAGO_HTTP_HOST=0.0.0.0',
            'AVAGO_HTTP_ALLOWED_HOSTS=*',
            `AVAGO_HTTP_PORT=${config.httpPort}`,
            `AVAGO_STAKING_PORT=${config.stakingPort}`,
            `AVAGO_TRACK_SUBNETS=${config.subnetIds.join(',')}`,
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
        location /ext/bc/${blockchainId}/rpc {
            limit_conn perip 500;
            proxy_pass http://${upstreamName};
            proxy_connect_timeout 5s;
            proxy_send_timeout 300s;
            proxy_read_timeout 300s;
        }`
        })
    })

    return `events {}
http {
    # Concurrent connection limiting: max 500 active connections per IP
    limit_conn_zone $$binary_remote_addr zone=perip:10m;
    
    # P-Chain upstream
    upstream backend_p_chain {
        server meganode01:9004;
    }
    
    # C-Chain upstream  
    upstream backend_c_chain {
        server meganode00:9002;
    }${upstreams}
    
    server {
        listen 80;
        
        # Route P-Chain to meganode01
        location /ext/bc/P {
            limit_conn perip 500;
            proxy_pass http://backend_p_chain;
            proxy_connect_timeout 5s;
            proxy_send_timeout 300s;
            proxy_read_timeout 300s;
        }
        
        # Route C-Chain (anything starting with /ext/bc/C) to meganode00
        location ~ ^/ext/bc/C {
            limit_conn perip 500;
            proxy_pass http://backend_c_chain;
            proxy_connect_timeout 5s;
            proxy_send_timeout 300s;
            proxy_read_timeout 300s;
        }
             
        ${locations}
        
        location / {
            return 200 'RPC Gateway OK\\n';
            add_header Content-Type text/plain;
        }
    }
}`
}

export function generateCompose(nodeSubnets: { [key: string]: string[] }, subnetsToBlockchainId: { [key: string]: string[] }, domain: string): string {
    const composeObject: {
        services: { [key: string]: any }
        configs: { [key: string]: any }
    } = {
        services: {},
        configs: {}
    }

    let nextHttpPort = 9000
    const serviceConfigs: { serviceName: string, httpPort: number, blockchainIds: string[] }[] = []

    // Generate services for each node
    Object.entries(nodeSubnets).forEach(([nodeId, subnets]) => {
        const nodeIdPadded = padzero(parseInt(nodeId), 2)
        const serviceName = `meganode${nodeIdPadded}`

        nextHttpPort += 2

        // Collect all blockchain IDs for this node's subnets
        const blockchainIds: string[] = []
        subnets.forEach(subnetId => {
            const blockchainIdsForSubnet = subnetsToBlockchainId[subnetId] || []
            blockchainIds.push(...blockchainIdsForSubnet)
        })

        composeObject.services[serviceName] = generateService({
            serviceName: serviceName,
            containerName: serviceName,
            folderSuffix: nodeIdPadded,
            httpPort: nextHttpPort,
            stakingPort: nextHttpPort + 1,
            subnetIds: subnets,
            blockchainIds: blockchainIds,
            skipCChain: parseInt(nodeId) !== 0, // Only node 0 syncs C-Chain
        })

        serviceConfigs.push({
            serviceName,
            httpPort: nextHttpPort,
            blockchainIds
        })
    })

    // Add nginx service
    composeObject.services.nginx = {
        image: 'nginx:1.25-alpine',
        container_name: 'nginx',
        configs: [
            {
                source: 'nginx_conf',
                target: '/etc/nginx/nginx.conf',
                mode: '0444'
            }
        ],
        ports: [
            '80:80'
        ],
        restart: 'unless-stopped',
        depends_on: Object.keys(composeObject.services)
    }

    // Add nginx config
    composeObject.configs = {
        nginx_conf: {
            content: generateNginxConfig(serviceConfigs)
        }
    }

    return YAML.stringify(composeObject)
}
