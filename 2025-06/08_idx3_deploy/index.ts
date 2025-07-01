import fs from 'fs'
import chains from "../01_rpc_list/data/chains.json"
import YAML from 'yaml'

// Build services object
const services: Record<string, any> = {}

function getRps(endpoint: string) {
    if (endpoint.includes("meganode.solokhin.com")) {
        return 50
    } else if (endpoint.includes("subnets.avax.network")) {
        return 2//TODO: change to 6. UP: even 5 throws 429
    } else {
        return 20
    }
}

function replaceRpcUrl(endpoint: string) {
    return endpoint.replace("https://meganode.solokhin.com", "http://65.21.140.118")
}

function getBlocksPerBatch(endpoint: string) {
    return 50
}

function getRequestBatchSize(endpoint: string) {
    return 10
}

for (const chain of chains) {
    // Only add service if rpcUrl is present and not empty/null
    if (chain.rpcUrl) {

        services[`indexer_${chain.blockchainId}`] = {
            image: "containerman17/idx3:latest",
            container_name: `indexer_${chain.blockchainId}`,
            environment: [
                `RPC_URL=${replaceRpcUrl(chain.rpcUrl)}`,
                `CHAIN_ID=${chain.blockchainId}`,
                "DATA_DIR=/data/",
                `RPS=${getRps(chain.rpcUrl)}`,
                `REQUEST_BATCH_SIZE=${getRequestBatchSize(chain.rpcUrl)}`,
                `MAX_CONCURRENT=${getRps(chain.rpcUrl)}`,//RPS is also max concurrent
                `BLOCKS_PER_BATCH=${getBlocksPerBatch(chain.rpcUrl)}`,
                `DEBUG_RPC_AVAILABLE=${chain.debugEnabled ? 'true' : 'false'}`
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

services["dashboard"] = {
    image: "containerman17/indexer-dashboard",
    container_name: "dashboard",
    ports: [
        "80"
    ],
    labels: {
    },
    restart: "on-failure:100"
}

const composeObject = {
    services,
    networks: {},
    volumes: {
    }
}
const yamlStr = YAML.stringify(composeObject)
fs.writeFileSync('compose.yml', yamlStr)
