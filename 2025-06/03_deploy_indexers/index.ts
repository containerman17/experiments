import fs from 'fs'
import chains from "../01_rpc_list/data/chains.json"
import YAML from 'yaml'

// Build services object
const services: Record<string, any> = {}

function getRps(endpoint: string) {
    if (endpoint.includes("meganode.solokhin.com")) {
        return 50
    } else if (endpoint.includes("subnets.avax.network")) {
        return 3
    } else {
        return 10
    }
}

const smallBatchEndpoints = [
    "https://subnets.avax.network/beam/mainnet/rpc",
    "https://subnets.avax.network/playa3ull/mainnet/rpc",
    "https://subnets.avax.network/shrapnel/mainnet/rpc",
    "https://subnets.avax.network/dexalot/mainnet/rpc",
    "https://subnets.avax.network/coqnet/mainnet/rpc",
    "https://subnets.avax.network/defi-kingdoms/dfk-chain/rpc",
    "https://subnets.avax.network/blitz/mainnet/rpc",
    "https://subnets.avax.network/tiltyard/mainnet/rpc",
    "https://api.avax.network/ext/bc/C/rpc",
]

function getBlocksPerBatch(endpoint: string) {
    if (smallBatchEndpoints.includes(endpoint)) {
        return 50//TODO: tune this value
    }
    if (endpoint.includes("meganode.solokhin.com")) {
        return 10000
    } else {
        return 1000
    }
}

function getRequestBatchSize(endpoint: string) {
    if (smallBatchEndpoints.includes(endpoint)) {
        return 10//TODO: tune this value
    }
    if (endpoint.includes("meganode.solokhin.com")) {
        return 1000
    } else {
        return 100
    }
}

for (const chain of chains) {
    // Only add service if rpcUrl is present and not empty/null
    if (chain.rpcUrl) {
        services[`indexer_${chain.blockchainId}`] = {
            image: "containerman17/lean-explorer-core:latest",
            container_name: `indexer_${chain.blockchainId}`,
            environment: [
                `RPC_URL=${chain.rpcUrl}`,
                `CHAIN_ID=${chain.blockchainId}`,
                "DATA_DIR=/data/",
                `RPS=${getRps(chain.rpcUrl)}`,
                `REQUEST_BATCH_SIZE=${getRequestBatchSize(chain.rpcUrl)}`,
                `MAX_CONCURRENT=${getRps(chain.rpcUrl)}`,//RPS is also max concurrent
                `BLOCKS_PER_BATCH=${getBlocksPerBatch(chain.rpcUrl)}`
            ],
            volumes: [
                "/home/ilia/indexer_data:/data"
            ],
            networks: [
                "caddy"
            ],
            ports: [
                "3000" // random port
            ],
            labels: {
                caddy: chain.blockchainId + "." + process.env.CADDY_DOMAIN,
                "caddy.reverse_proxy": "{{upstreams 3000}}",
            },
            restart: "on-failure:100" // Add restart policy with sane limit
        }
    }
}

services["caddy"] = {
    image: "lucaslorentz/caddy-docker-proxy:ci-alpine",
    container_name: "caddy",
    restart: "unless-stopped",
    ports: [
        "80:80",
        "443:443"
    ],
    environment: [
        "CADDY_INGRESS_NETWORKS=caddy"
    ],
    networks: [
        "caddy"
    ],
    volumes: [
        "/var/run/docker.sock:/var/run/docker.sock",
        "caddy_data:/data"
    ]
}

const composeObject = {
    services,
    networks: { caddy: { external: true } },
    volumes: {
        caddy_data: {}
    }
}
const yamlStr = YAML.stringify(composeObject)
fs.writeFileSync('compose.yml', yamlStr)
