import fs from 'fs'
import chains from "../01_rpc_list/data/chains.json"
import YAML from 'yaml'

// Build services object
const services: Record<string, any> = {}

function getRps(endpoint: string) {
    if (endpoint.includes("solokhin.com")) {
        return 50
    } else if (endpoint.includes("subnets.avax.network")) {
        return 3
    } else {
        return 10
    }
}

function getBlocksPerBatch(endpoint: string) {
    if (endpoint.includes("solokhin.com")) {
        return 10000
    } else {
        return 1000
    }
}

function getRequestBatchSize(endpoint: string) {
    if (endpoint.includes("solokhin.com")) {
        return 1000
    } else {
        return 300
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
            ports: [
                "3000" // random port
            ],
            restart: "on-failure:100" // Add restart policy with sane limit
        }
    }
}

const composeObject = { services }
const yamlStr = YAML.stringify(composeObject)
fs.writeFileSync('compose.yml', yamlStr)
