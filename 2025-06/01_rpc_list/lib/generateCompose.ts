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
    domain: string
}

// Function to pad numbers with leading zeros
function padzero(num: number, size: number): string {
    return num.toString().padStart(size, '0')
}

// Function to generate a service configuration
function generateService(config: ServiceConfig) {
    const labels: { [key: string]: string } = {
        [`caddy`]: config.domain
    }
    config.blockchainIds.forEach((blockchainId, index) => {
        labels[`caddy.handle_path_${index}`] = `/ext/bc/${blockchainId}/rpc`
        labels[`caddy.handle_path_${index}.0_reverse_proxy`] = `{{upstreams ${config.httpPort}}}`
    })

    return {
        image: 'containerman17/subnet-evm-plus:latest',
        container_name: config.containerName,
        restart: 'always',
        networks: ['caddy'],
        ports: [
            `${config.httpPort}:${config.httpPort}`,
            `${config.stakingPort}:${config.stakingPort}`
        ],
        volumes: [
            `~/meganode_${config.folderSuffix}/:/root/.avalanchego`
        ],
        environment: [
            `AVAGO_PARTIAL_SYNC_PRIMARY_NETWORK=${config.skipCChain ? 'true' : 'false'}`,
            'AVAGO_PUBLIC_IP_RESOLUTION_SERVICE=opendns',
            'AVAGO_HTTP_HOST=127.0.0.1',
            `AVAGO_HTTP_PORT=${config.httpPort}`,
            `AVAGO_STAKING_PORT=${config.stakingPort}`,
            `AVAGO_TRACK_SUBNETS=${config.subnetIds.join(',')}`,
        ],
        labels,
        logging: {
            driver: 'json-file',
            options: {
                'max-size': '50m',
                'max-file': '3'
            }
        }
    }
}

export function generateCompose(nodeSubnets: { [key: string]: string[] }, subnetsToBlockchainId: { [key: string]: string[] }, domain: string): string {
    const composeObject: {
        services: { [key: string]: any }
        networks: { [key: string]: any }
        volumes: { [key: string]: any }
    } = {
        services: {},
        networks: {
            caddy: {
                external: true
            }
        },
        volumes: {
            caddy_data: {}
        }
    }

    // Add Caddy service with global options based on domain scheme
    const isHttpOnly = domain.startsWith('http://')
    const caddyService: any = {
        container_name: 'caddy',
        image: 'lucaslorentz/caddy-docker-proxy:ci-alpine',
        ports: [
            '80:80',
            '443:443'
        ],
        environment: [
            'CADDY_INGRESS_NETWORKS=caddy'
        ],
        networks: ['caddy'],
        volumes: [
            '/var/run/docker.sock:/var/run/docker.sock',
            'caddy_data:/data'
        ],
        restart: 'unless-stopped'
    }

    // Add global options for HTTP-only mode
    if (isHttpOnly) {
        caddyService.environment.push('CADDY_GLOBAL_OPTIONS={\n\tauto_https off\n}')
    }

    composeObject.services.caddy = caddyService

    let nextHttpPort = 9000

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
            domain: domain
        })
    })

    return YAML.stringify(composeObject)
}
